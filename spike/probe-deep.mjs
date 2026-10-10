// Probe 2: bypass the broken `exports` map by importing the REAL emit paths
// directly (a relative file path sidesteps Node's exports gate). Does the
// package work if you route around the packaging bug?
const real = (p, n) =>
  `../node_modules/@runmesh/${p}/dist/framework/packages/${p}/src/${n}.js`;

for (const [pkg, file] of [
  ['core', 'index'],
  ['tools', 'index'],
  ['agent', 'index'],
]) {
  try {
    const m = await import(real(pkg, file));
    console.log(`OK   deep @runmesh/${pkg} -> ${Object.keys(m).join(', ')}`);
  } catch (e) {
    console.log(`FAIL deep @runmesh/${pkg} -> ${e.code}: ${e.message.split('\n')[0]}`);
  }
}
