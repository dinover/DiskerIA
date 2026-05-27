'use strict';
// Embeds logo.ico and logo.png as base64 into assets-data.js
// so pkg can bundle them without filesystem snapshot issues.
const fs = require('fs');

const ico = fs.readFileSync('assets/logo.ico');
const png = fs.readFileSync('assets/logo.png');

fs.writeFileSync(
  'assets-data.js',
  `'use strict';\n` +
  `module.exports = {\n` +
  `  ico: Buffer.from('${ico.toString('base64')}', 'base64'),\n` +
  `  png: Buffer.from('${png.toString('base64')}', 'base64'),\n` +
  `};\n`
);

console.log(`assets-data.js generated  ico:${ico.length}b  png:${png.length}b`);
