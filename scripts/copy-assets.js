const fs = require('node:fs');
const path = require('node:path');
const source = path.resolve(__dirname, '..', 'src', 'renderer');
const target = path.resolve(__dirname, '..', 'dist', 'renderer');
fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.cpSync(source, target, { recursive: true });
console.log(`Renderer assets copied to ${target}`);
