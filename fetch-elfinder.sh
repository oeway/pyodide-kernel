wget https://github.com/imjoy-team/elFinder/archive/refs/heads/gh-pages.zip
unzip gh-pages.zip 
rm gh-pages.zip 
rm -rf build/docs-app/elFinder
mv elFinder-gh-pages/ build/docs-app/elFinder
cp build/docs-app/elFinder/service-worker.js build/docs-app
cp build/docs-app/elFinder/service-worker.js.map build/docs-app
# mkdir -p build/docs-app/elFinder
# cp -R /Users/wei.ouyang/workspace/elFinder/elfinder_client/* build/docs-app/elFinder
# cp build/docs-app/elFinder/service-worker.js build/docs-app
# cp build/docs-app/elFinder/service-worker.js.map build/docs-app