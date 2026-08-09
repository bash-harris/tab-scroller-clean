const { launchWithExtension, configureOllama } = require('./runner');

(async () => {
  console.log('Testing launchWithExtension...');
  const result = await launchWithExtension();
  console.log('Launched! bgTarget:', result.bgTarget.url());
  console.log('extId:', result.extId);

  const bgCdp = await result.bgTarget.createCDPSession();
  console.log('CDP session created');

  await configureOllama(bgCdp);
  console.log('Ollama configured');

  await bgCdp.detach();
  await result.browser.close();
  console.log('Done');
})();
