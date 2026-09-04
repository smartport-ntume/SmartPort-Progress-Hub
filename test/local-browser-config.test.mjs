import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import vm from 'node:vm';

test('production local browser config ignores backend and API URL query overrides', async () => {
  const source = await fs.readFile(new URL('../js/config.js', import.meta.url), 'utf8');
  const window = {
    location: {
      search: '?backend=supabase&apiBase=https://evil.example',
      hostname: 'progresshub.lab.ntu.edu.tw',
      origin: 'https://progresshub.lab.ntu.edu.tw'
    },
    SMARTPORT_RUNTIME_CONFIG: {
      backendMode: 'local',
      lockBackend: true,
      apiBase: 'same-origin',
      lockApiBase: true
    }
  };
  vm.runInNewContext(source, { window, URLSearchParams });

  assert.equal(window.SMARTPORT_CONFIG.backendMode, 'local');
  assert.equal(window.SMARTPORT_CONFIG.apiBase, 'https://progresshub.lab.ntu.edu.tw');
  assert.equal(window.SMARTPORT_CONFIG.apiBaseLocked, true);
});
