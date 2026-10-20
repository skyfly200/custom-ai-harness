// The model-info checks again with OpenRouter's price list failing
process.env.OPENROUTER_DOWN = '1';
require('./modelInfoApi.test.js');
