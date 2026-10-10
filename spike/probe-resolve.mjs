// Probe: does @runmesh/* resolve via its published entry point at all?
for (const pkg of ['@runmesh/core', '@runmesh/agent', '@runmesh/tools']) {
  try {
    const m = await import(pkg);
    console.log(`OK   ${pkg} -> exports: ${Object.keys(m).join(', ')}`);
  } catch (e) {
    console.log(`FAIL ${pkg} -> ${e.code}: ${e.message.split('\n')[0]}`);
  }
}
