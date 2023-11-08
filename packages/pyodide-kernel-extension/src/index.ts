// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { PageConfig, URLExt } from '@jupyterlab/coreutils';

import {
  IServiceWorkerManager,
  JupyterLiteServer,
  JupyterLiteServerPlugin,
} from '@jupyterlite/server';

import { IKernel, IKernelSpecs } from '@jupyterlite/kernel';
import { IBroadcastChannelWrapper } from '@jupyterlite/contents';

export * as KERNEL_SETTINGS_SCHEMA from '../schema/kernel.v0.schema.json';
import KERNEL_ICON_SVG_STR from '../style/img/pyodide.svg';

const KERNEL_ICON_URL = `data:image/svg+xml;base64,${btoa(KERNEL_ICON_SVG_STR)}`;

/**
 * The default CDN fallback for Pyodide
 */
const PYODIDE_CDN_URL = 'https://cdn.jsdelivr.net/pyodide/v0.23.4/full/pyodide.js';

/**
 * The id for the extension, and key in the litePlugins.
 */
const PLUGIN_ID = '@jupyterlite/pyodide-kernel-extension:kernel';

function timeout(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Attempt to unregister the current service worker
async function unregisterAndRegisterServiceWorker() {
  if ('serviceWorker' in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    for (const registration of registrations) {
      if (
        registration.active &&
        !registration.active.scriptURL.endsWith('/service-worker.js')
      ) {
        await registration.unregister();
        console.log(
          'Unregistered service worker (jupyter server): ',
          registration.active.scriptURL
        );
      }
    }
    // After all unregistrations are done, register your custom service worker
    if ('serviceWorker' in navigator) {
      const controller = navigator.serviceWorker.controller;
      // Register the worker and show the list of quotations.
      if (!controller || !controller.scriptURL.endsWith('/service-worker.js')) {
        navigator.serviceWorker.oncontrollerchange = function () {
          if (this.controller) {
            this.controller.onstatechange = function () {
              if (this.state === 'activated') {
                console.log(
                  'Service worker (elFinder-compatible) successfully activated.'
                );
              }
            };
          }
        };
        const registration = await navigator.serviceWorker.register(
          './service-worker.js'
        );
        console.log(
          'Service worker (elFinder-compatible) successfully registered, scope is:',
          registration.scope
        );
        // Wait for the service worker to become active
        await navigator.serviceWorker.ready;
        // Reload the page to allow the service worker to intercept requests
        if (!navigator.serviceWorker.controller) {
          // Service worker has just been installed, reload the page
          window.location.reload();
          throw new Error(
            'Reload the page to allow the service worker to intercept requests.'
          );
        }
        let ready = false;
        while (!ready) {
          const response = await fetch('/fs/connector');
          if (response.status === 200) {
            ready = true;
            break;
          }
          await timeout(500);
        }
      } else {
        console.log(
          'Service Worker (elFinder-compatible) registration successful with scope: ',
          controller.scriptURL
        );
      }
    } else {
      console.log('Failed to register service worker (elFinder-compatible).');
    }
  }
}

/**
 * A plugin to register the Pyodide kernel.
 */
const kernel: JupyterLiteServerPlugin<void> = {
  id: PLUGIN_ID,
  autoStart: true,
  requires: [IKernelSpecs],
  optional: [IServiceWorkerManager, IBroadcastChannelWrapper],
  activate: (
    app: JupyterLiteServer,
    kernelspecs: IKernelSpecs,
    serviceWorker?: IServiceWorkerManager,
    broadcastChannel?: IBroadcastChannelWrapper
  ) => {
    const config =
      JSON.parse(PageConfig.getOption('litePluginSettings') || '{}')[PLUGIN_ID] || {};
    const url = config.pyodideUrl || PYODIDE_CDN_URL;
    const pyodideUrl = URLExt.parse(url).href;
    const pipliteWheelUrl = config.pipliteWheelUrl
      ? URLExt.parse(config.pipliteWheelUrl).href
      : undefined;
    const rawPipUrls = config.pipliteUrls || [];
    const pipliteUrls = rawPipUrls.map((pipUrl: string) => URLExt.parse(pipUrl).href);
    const disablePyPIFallback = !!config.disablePyPIFallback;
    kernelspecs.register({
      spec: {
        name: 'python',
        display_name: 'Python (Pyodide)',
        language: 'python',
        argv: [],
        resources: {
          'logo-32x32': KERNEL_ICON_URL,
          'logo-64x64': KERNEL_ICON_URL,
        },
      },
      create: async (options: IKernel.IOptions): Promise<IKernel> => {
        await unregisterAndRegisterServiceWorker();
        const { PyodideKernel } = await import('@jupyterlite/pyodide-kernel');
        const mountDrive = !!(serviceWorker?.enabled && broadcastChannel?.enabled);

        if (mountDrive) {
          console.info('Pyodide contents will be synced with Jupyter Contents');
        } else {
          console.warn('Pyodide contents will NOT be synced with Jupyter Contents');
        }

        return new PyodideKernel({
          ...options,
          pyodideUrl,
          pipliteWheelUrl,
          pipliteUrls,
          disablePyPIFallback,
          mountDrive,
        });
      },
    });
  },
};

const plugins: JupyterLiteServerPlugin<any>[] = [kernel];

export default plugins;
