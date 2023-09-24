// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

// Types and implementation inspired from https://github.com/jvilk/BrowserFS
// LICENSE: https://github.com/jvilk/BrowserFS/blob/8977a704ea469d05daf857e4818bef1f4f498326/LICENSE
// And from https://github.com/gzuidhof/starboard-notebook

// LICENSE: https://github.com/gzuidhof/starboard-notebook/blob/cd8d3fc30af4bd29cdd8f6b8c207df8138f5d5dd/LICENSE
import {
  FS,
  ERRNO_CODES,
  PATH,
  DIR_MODE,
  SEEK_CUR,
  SEEK_END,
  IEmscriptenStream,
  IEmscriptenStreamOps,
  IEmscriptenNodeOps,
  IEmscriptenFSNode,
  IStats,
} from '@jupyterlite/contents/lib/emscripten';

import lz from 'lzutf8';

// export const DRIVE_SEPARATOR = ':';
// export const DRIVE_API_PATH = '/api/drive.v1';

export const BLOCK_SIZE = 4096;

// function base64AddPadding(str: string) {
//   return str + Array(((4 - (str.length % 4)) % 4) + 1).join('=');
// }

function parseVolume(volumes: string[], p: string) {
  const v: number = getVolume(volumes, p);
  const root = volumes[v] || '';
  let relative = p.substr(root.length, p.length - root.length);
  if (relative.indexOf('/') !== 0) {
    relative = '/' + relative;
  }
  return {
    volume: v,
    dir: root,
    path: relative,
    isRoot: relative === '/',
  };
}

function getVolume(volumes: string[], p: string) {
  for (let i = 0; i < volumes.length; i++) {
    if (i > 9) {
      return -1;
    }
    if (p.indexOf(volumes[i]) === 0) {
      return i;
    }
  }
  return -1;
}

export type TDriveMethod =
  | 'open'
  | 'info'
  | 'get'
  | 'put'
  | 'mkfile'
  | 'mkdir'
  | 'rm'
  | 'rename'
  | 'paste'
  | 'ls';

/**
 * Interface of a request on the /api/drive endpoint
 */
export interface IDriveRequest {
  /**
   * The method of the request (rmdir, readdir etc)
   */
  cmd: TDriveMethod;
  reload?: number;
  tree?: number;
  name?: string;
  current?: string;
  target?: string;
  dirs?: string[];
  targets?: string[];
  conv?: number;
  content?: string | Uint8Array;
  encoding?: string;
  dst?: string;
  cut?: string;
  renames?: string[];
  suffix?: string;
}

// Mapping flag -> do we need to overwrite the file upon closing it
const flagNeedsWrite: { [flag: number]: boolean } = {
  0 /*O_RDONLY*/: false,
  1 /*O_WRONLY*/: true,
  2 /*O_RDWR*/: true,
  64 /*O_CREAT*/: true,
  65 /*O_WRONLY|O_CREAT*/: true,
  66 /*O_RDWR|O_CREAT*/: true,
  129 /*O_WRONLY|O_EXCL*/: true,
  193 /*O_WRONLY|O_CREAT|O_EXCL*/: true,
  514 /*O_RDWR|O_TRUNC*/: true,
  577 /*O_WRONLY|O_CREAT|O_TRUNC*/: true,
  578 /*O_CREAT|O_RDWR|O_TRUNC*/: true,
  705 /*O_WRONLY|O_CREAT|O_EXCL|O_TRUNC*/: true,
  706 /*O_RDWR|O_CREAT|O_EXCL|O_TRUNC*/: true,
  1024 /*O_APPEND*/: true,
  1025 /*O_WRONLY|O_APPEND*/: true,
  1026 /*O_RDWR|O_APPEND*/: true,
  1089 /*O_WRONLY|O_CREAT|O_APPEND*/: true,
  1090 /*O_RDWR|O_CREAT|O_APPEND*/: true,
  1153 /*O_WRONLY|O_EXCL|O_APPEND*/: true,
  1154 /*O_RDWR|O_EXCL|O_APPEND*/: true,
  1217 /*O_WRONLY|O_CREAT|O_EXCL|O_APPEND*/: true,
  1218 /*O_RDWR|O_CREAT|O_EXCL|O_APPEND*/: true,
  4096 /*O_RDONLY|O_DSYNC*/: true,
  4098 /*O_RDWR|O_DSYNC*/: true,
};

/** Implementation-specifc extension of an open stream, adding the file. */
export interface IDriveStream extends IEmscriptenStream {
  file?: DriveFS.IFile;
}

export class DriveFSEmscriptenStreamOps implements IEmscriptenStreamOps {
  private fs: DriveFS;

  constructor(fs: DriveFS) {
    this.fs = fs;
  }

  open(stream: IDriveStream): void {
    const path = this.fs.realPath(stream.node);
    if (this.fs.FS.isFile(stream.node.mode)) {
      stream.file = this.fs.API.get(path);
    }
  }

  close(stream: IDriveStream): void {
    if (!this.fs.FS.isFile(stream.node.mode) || !stream.file) {
      return;
    }

    const path = this.fs.realPath(stream.node);

    const flags = stream.flags;
    let parsedFlags = typeof flags === 'string' ? parseInt(flags, 10) : flags;
    parsedFlags &= 0x1fff;

    let needsWrite = true;
    if (parsedFlags in flagNeedsWrite) {
      needsWrite = flagNeedsWrite[parsedFlags];
    }

    if (needsWrite) {
      this.fs.API.put(path, stream.file);
    }

    stream.file = undefined;
  }

  read(
    stream: IDriveStream,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): number {
    if (
      length <= 0 ||
      stream.file === undefined ||
      position >= (stream.file.data.length || 0)
    ) {
      return 0;
    }

    const size = Math.min(stream.file.data.length - position, length);
    buffer.set(stream.file.data.subarray(position, position + size), offset);
    return size;
  }

  write(
    stream: IDriveStream,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): number {
    if (length <= 0 || stream.file === undefined) {
      return 0;
    }

    stream.node.timestamp = Date.now();

    if (position + length > (stream.file?.data.length || 0)) {
      const oldData = stream.file.data ? stream.file.data : new Uint8Array(0);
      stream.file.data = new Uint8Array(position + length);
      stream.file.data.set(oldData);
    }

    stream.file.data.set(buffer.subarray(offset, offset + length), position);

    return length;
  }

  llseek(stream: IDriveStream, offset: number, whence: number): number {
    let position = offset;
    if (whence === SEEK_CUR) {
      position += stream.position;
    } else if (whence === SEEK_END) {
      if (this.fs.FS.isFile(stream.node.mode)) {
        if (stream.file !== undefined) {
          position += stream.file.data.length;
        } else {
          throw new this.fs.FS.ErrnoError(this.fs.ERRNO_CODES.EPERM);
        }
      }
    }

    if (position < 0) {
      throw new this.fs.FS.ErrnoError(this.fs.ERRNO_CODES.EINVAL);
    }

    return position;
  }
}

export class DriveFSEmscriptenNodeOps implements IEmscriptenNodeOps {
  private fs: DriveFS;

  constructor(fs: DriveFS) {
    this.fs = fs;
  }

  getattr(node: IEmscriptenFSNode): IStats {
    return {
      ...this.fs.API.getattr(this.fs.realPath(node)),
      mode: node.mode,
      ino: node.id,
    };
  }

  setattr(node: IEmscriptenFSNode, attr: IStats): void {
    for (const [key, value] of Object.entries(attr)) {
      switch (key) {
        case 'mode':
          node.mode = value;
          break;
        case 'timestamp':
          node.timestamp = value;
          break;
        default:
          console.warn('setattr', key, 'of', value, 'on', node, 'not yet implemented');
          break;
      }
    }
  }

  lookup(parent: IEmscriptenFSNode, name: string): IEmscriptenFSNode {
    const path = this.fs.PATH.join2(this.fs.realPath(parent), name);
    const result = this.fs.API.lookup(path);
    if (!result.ok) {
      throw this.fs.FS.genericErrors[this.fs.ERRNO_CODES['ENOENT']];
    }
    return this.fs.createNode(parent, name, result.mode, 0);
  }

  mknod(
    parent: IEmscriptenFSNode,
    name: string,
    mode: number,
    dev: number,
  ): IEmscriptenFSNode {
    const path = this.fs.PATH.join2(this.fs.realPath(parent), name);
    this.fs.API.mknod(path, mode);
    return this.fs.createNode(parent, name, mode, dev);
  }

  rename(oldNode: IEmscriptenFSNode, newDir: IEmscriptenFSNode, newName: string): void {
    this.fs.API.rename(
      oldNode.parent
        ? this.fs.PATH.join2(this.fs.realPath(oldNode.parent), oldNode.name)
        : oldNode.name,
      this.fs.PATH.join2(this.fs.realPath(newDir), newName),
    );

    // Updating the in-memory node
    oldNode.name = newName;
    oldNode.parent = newDir;
  }

  unlink(parent: IEmscriptenFSNode, name: string): void {
    this.fs.API.rmdir(this.fs.PATH.join2(this.fs.realPath(parent), name));
  }

  rmdir(parent: IEmscriptenFSNode, name: string) {
    this.fs.API.rmdir(this.fs.PATH.join2(this.fs.realPath(parent), name));
  }

  readdir(node: IEmscriptenFSNode): string[] {
    return this.fs.API.readdir(this.fs.realPath(node));
  }

  symlink(parent: IEmscriptenFSNode, newName: string, oldPath: string): void {
    throw new this.fs.FS.ErrnoError(this.fs.ERRNO_CODES['EPERM']);
  }

  readlink(node: IEmscriptenFSNode): string {
    throw new this.fs.FS.ErrnoError(this.fs.ERRNO_CODES['EPERM']);
  }
}

export class ContentsAPI {
  constructor(
    baseUrl: string,
    driveName: string,
    mountpoint: string,
    FS: FS,
    ERRNO_CODES: ERRNO_CODES,
  ) {
    this._baseUrl = baseUrl;
    this._driveName = ''; //driveName;
    this._mountpoint = mountpoint;
    this.FS = FS;
    this.ERRNO_CODES = ERRNO_CODES;
    // this.volume = "0";
    // this.PATH = PATH;
    const response = this.request({
      cmd: 'open',
      reload: 1,
      target: 'v0_Lw',
      tree: 0,
    });
    this._rootDirs = response.files.filter(
      (file: any) => file.mime === 'directory' && file.hash.endsWith('_Lw'),
    );
    this._volumes = this._rootDirs.map((file: any) => '/' + file.name);
    console.log('rootDirs', this._rootDirs);
  }

  encode(path: string): string {
    path = this.normalizePath(path);
    const info = parseVolume(this._volumes, path);
    if (info.volume === -1) {
      throw new this.FS.ErrnoError(this.ERRNO_CODES['ENOENT']);
    }
    let relative = info.path;
    if (relative !== '/' && relative.startsWith('/')) {
      relative = relative.substring(1);
    }

    relative = lz
      .compress(relative, {
        outputEncoding: 'Base64',
      })
      .replace(/=+$/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '.');
    return 'v' + info.volume + '_' + relative;
  }

  // decode(dir: string): string {
  //   if (!dir || dir.length < 4) {
  //     throw Error('Invalid Path: ' + dir);
  //   }
  //   if (dir[0] !== 'v' || dir[2] !== '_') {
  //     throw Error('Invalid Path: ' + dir);
  //   }

  //   // const volume = parseInt(dir[1]);

  //   let relative = dir
  //     .substring(3)
  //     .replace(/-/g, '+')
  //     .replace(/_/g, '/')
  //     .replace(/\./g, '=');

  //   relative = lz.decompress(base64AddPadding(relative), {
  //     inputEncoding: 'Base64',
  //   });
  //   relative = this._driveName + '/' + relative
  //   relative = relative.replace(/\/+/g, '/');
  //   return relative;
  // }

  request(data: IDriveRequest): any {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', encodeURI(`${this.endpoint}/?cmd=${data.cmd}`), false);
    const formData = new FormData();
    // add the data object to the form by keys
    Object.keys(data).forEach((key) => {
      const value = (data as Record<string, any>)[key];
      if (Array.isArray(value)) {
        value.forEach((v) => {
          formData.append(key + '[]', v);
        });
      } else {
        formData.append(key, value);
      }
    });

    try {
      xhr.send(formData);
    } catch (e) {
      console.error(e);
    }

    if (xhr.status >= 400) {
      throw new this.FS.ErrnoError(this.ERRNO_CODES['EINVAL']);
    }
    return JSON.parse(xhr.responseText);
  }

  lookup(path: string): DriveFS.ILookup {
    try {
      const encodedPath = this.encode(path);
      const response = this.request({ cmd: 'info', targets: [encodedPath] });

      const lookupResult: DriveFS.ILookup = {
        ok: response.files[0] ? true : false,
        mode: 0,
      };

      if (lookupResult.ok) {
        const file = response.files[0];

        const baseMode = file.mime === 'directory' ? 0o40000 : 0o100000;
        if (file.read === 1 && file.write === 1) {
          lookupResult.mode = baseMode | 0o755;
        } else if (file.read === 1) {
          lookupResult.mode = baseMode | 0o444;
        } else if (file.write === 1) {
          lookupResult.mode = baseMode | 0o222;
        } else {
          lookupResult.mode = baseMode | 0o000;
        }
      }
      return lookupResult;
    } catch (e) {
      return { ok: false, mode: 0 };
    }
  }

  getmode(path: string): number {
    const hash = this.encode(path); // assuming encode method returns the hash
    let mode = 0; // initialize mode to 0000

    // Request file/directory info
    const response = this.request({
      cmd: 'info',
      targets: [hash],
    });

    // Check if we received valid info
    if (response.files && response.files.length > 0) {
      const fileInfo = response.files[0];

      if (fileInfo.read) {
        mode |= 0o444; // set read bits if readable
      }

      if (fileInfo.write) {
        mode |= 0o222; // set write bits if writable
      }
    }

    return mode;
  }

  mknod(path: string, mode: number) {
    const encodedPath = this.encode(path);
    const parentDir = this.encode(
      encodedPath.substring(0, encodedPath.lastIndexOf('/')),
    );
    let cmd: 'mkdir' | 'mkfile';
    const result = { ok: false };

    // Determine whether to create a file or directory
    if (this.FS.isDir(mode)) {
      cmd = 'mkdir';
    } else if (this.FS.isFile(mode)) {
      cmd = 'mkfile';
    } else {
      return result; // Unknown type, return false
    }

    // Create a file or directory based on the command
    const name = path.substring(path.lastIndexOf('/') + 1);
    const response = this.request({
      cmd: cmd,
      target: parentDir,
      name: name,
    });

    // Check if the file/directory was successfully created
    if (response.added && response.added.length > 0) {
      result.ok = true;
    }

    return result;
  }

  rename(oldPath: string, newPath: string): void {
    const hash = this.encode(oldPath); // assuming encode method returns the hash
    // Send a rename command to the server
    this.request({
      cmd: 'paste',
      dst: this.encode(newPath),
      targets: [hash],
      cut: '1',
      renames: [],
      suffix: '~',
    });
  }

  readdir(path: string): string[] {
    if (path === this._mountpoint) {
      return ['.', ...this._rootDirs.map((file: any) => file.name)];
    }

    const hash = this.encode(path); // assuming encode method returns the hash

    // Send an ls command to the server
    const response = this.request({
      cmd: 'ls',
      target: hash,
    });
    return ['.', '..', ...response.list];
  }

  rmdir(path: string): void {
    const hash = this.encode(path); // assuming encode method returns the hash
    // Send a delete command to the server
    this.request({
      cmd: 'rm',
      targets: [hash],
    });
  }

  get(path: string): DriveFS.IFile {
    // Assuming you have a method to get the hash code from the path
    const hash = this.encode(path);
    // const dirHash = this.encodeDir(path); // Assuming you can get directory hash
    try {
      const response = this.request({
        cmd: 'get',
        // current: dirHash,
        target: hash,
        // conv: 1 // auto-detect encoding
      });

      // Error handling: if content is false, an error occurred
      if (response.content === false) {
        throw new Error('Failed to get file content');
      }

      let data: Uint8Array;
      let format: 'json' | 'text' | 'base64';

      // If the content is a Data URI Scheme String, it's not a text file
      if (response.content.startsWith('data:')) {
        format = 'base64';
        const base64Data = response.content.split(',')[1];
        data = Uint8Array.from(atob(base64Data), (c) => c.charCodeAt(0));
      } else {
        // Otherwise, it's a UTF-8 text file
        format = 'text';
        const text = response.content;
        data = new TextEncoder().encode(text);
      }
      return {
        data,
        format,
      };
    } catch (e) {
      console.error(e);
      throw new this.FS.ErrnoError(this.ERRNO_CODES['ENOENT']);
    }
  }

  put(path: string, value: DriveFS.IFile) {
    // Convert path to hash code
    const hash = this.encode(path);

    let content: string;
    let encoding: string;

    // Handle content and encoding based on value.format
    switch (value.format) {
      case 'json':
        content = JSON.stringify(value.data);
        encoding = 'utf8';
        break;
      case 'text':
        content = new TextDecoder().decode(value.data);
        encoding = 'utf8';
        break;
      case 'base64':
        content = btoa(String.fromCharCode(...value.data));
        encoding = 'scheme'; // Data URI Scheme
        content = `data:application/octet-stream;base64,${content}`;
        break;
      default:
        throw new Error(`Unknown format: ${value.format}`);
    }

    // Perform the PUT request
    const response = this.request({
      cmd: 'put',
      target: hash,
      content,
      encoding,
    });

    if (response.error) {
      console.error(`Error: ${response.error}`);
      return { ok: false };
    }

    return { ok: true };
  }

  getattr(path: string): IStats {
    // Assume you have a method to get the hash code from the path
    const hash = this.encode(path); // or however you convert path to hash

    // Fetch the information about this node (file/directory) using the info command
    const response = this.request({
      cmd: 'info',
      targets: [hash],
    });

    // Assume first entry in 'files' array corresponds to the queried path
    const info = response.files[0];

    const baseMode = info.mime === 'directory' ? 0o40000 : 0o100000;
    // Create a new IStats object populated with converted values from info
    const stats: IStats = {
      dev: 1, // a placeholder, or derive from volume info
      ino: 1, // or some unique identifier for the inode
      mode:
        baseMode |
        (info.read && info.write
          ? 0o666
          : info.read
          ? 0o444
          : info.write
          ? 0o222
          : 0o000),
      nlink: 1, // default for most files
      uid: 0, // user id placeholder, could also be derived
      gid: 0, // group id placeholder, could also be derived
      rdev: 0, // no special device
      size: info.size || 0, // size in bytes
      blksize: BLOCK_SIZE, // a standard block size, could be different
      blocks: Math.ceil((info.size || 0) / BLOCK_SIZE), // number of 4K blocks
      atime: new Date(), // should be real value if available
      mtime: new Date(info.ts * 1000), // convert Unix timestamp to Date object
      ctime: new Date(), // inode change time, should be real value if available
      timestamp: 0, //info.ts, // keep original Unix timestamp if necessary
    };

    return stats;
  }

  /**
   * Normalize a Path by making it compliant for the content manager
   *
   * @param path: the path relatively to the Emscripten drive
   */
  normalizePath(path: string): string {
    // Remove mountpoint prefix
    if (path.startsWith(this._mountpoint)) {
      path = path.slice(this._mountpoint.length);
    }
    if (!path || path === '') {
      path = '/';
    }
    // Add JupyterLab drive name
    if (this._driveName) {
      // replace // to /
      path = `${this._driveName}/${path}`.replace(/\/+/g, '/');
    }
    return path;
  }

  /**
   * Get the api/drive endpoint
   */
  get endpoint(): string {
    return `${this._baseUrl}/fs/connector`;
  }

  private _volumes: string[];
  private _rootDirs: any[];
  private _baseUrl: string;
  private _driveName: string;
  private _mountpoint: string;
  private FS: FS;
  private ERRNO_CODES: ERRNO_CODES;
}

export class DriveFS {
  FS: FS;
  API: ContentsAPI;
  PATH: PATH;
  ERRNO_CODES: ERRNO_CODES;
  driveName: string;

  constructor(options: DriveFS.IOptions) {
    this.FS = options.FS;
    this.PATH = options.PATH;
    this.ERRNO_CODES = options.ERRNO_CODES;
    this.API = new ContentsAPI(
      options.baseUrl,
      options.driveName,
      options.mountpoint,
      this.FS,
      this.ERRNO_CODES,
    );
    this.driveName = options.driveName;

    this.node_ops = new DriveFSEmscriptenNodeOps(this);
    this.stream_ops = new DriveFSEmscriptenStreamOps(this);
  }

  node_ops: IEmscriptenNodeOps;
  stream_ops: IEmscriptenStreamOps;

  mount(mount: any): IEmscriptenFSNode {
    return this.createNode(null, mount.mountpoint, DIR_MODE | 511, 0);
  }

  createNode(
    parent: IEmscriptenFSNode | null,
    name: string,
    mode: number,
    dev: number,
  ): IEmscriptenFSNode {
    const FS = this.FS;
    if (!FS.isDir(mode) && !FS.isFile(mode)) {
      throw new FS.ErrnoError(this.ERRNO_CODES['EINVAL']);
    }
    const node = FS.createNode(parent, name, mode, dev);
    node.node_ops = this.node_ops;
    node.stream_ops = this.stream_ops;
    return node;
  }

  getMode(path: string): number {
    return this.API.getmode(path);
  }

  realPath(node: IEmscriptenFSNode): string {
    const parts: string[] = [];
    let currentNode: IEmscriptenFSNode = node;

    parts.push(currentNode.name);
    while (currentNode.parent !== currentNode) {
      currentNode = currentNode.parent;
      parts.push(currentNode.name);
    }
    parts.reverse();

    return this.PATH.join.apply(null, parts);
  }
}

/**
 * A namespace for DriveFS configurations, etc.
 */
export namespace DriveFS {
  /**
   * A file representation;
   */
  export interface IFile {
    data: Uint8Array;
    format: 'json' | 'text' | 'base64';
  }

  /**
   * The response to a lookup request;
   */
  export interface ILookup {
    ok: boolean;
    mode: number;
  }

  /**
   * Initialization options for a drive;
   */
  export interface IOptions {
    FS: FS;
    PATH: PATH;
    ERRNO_CODES: ERRNO_CODES;
    baseUrl: string;
    driveName: string;
    mountpoint: string;
  }
}
