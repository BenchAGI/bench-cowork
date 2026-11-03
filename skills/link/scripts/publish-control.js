/* global document, module */
/* Reusable /link-this control. The private localhost adapter supplies authenticated
 * request() and upload()/replace() functions; no credential is put in markup. */
(function (root) {
  'use strict';
  const policies = ['workspace', 'workspace_managers', 'public'];
  function selectAccess(requested, saved) {
    if (saved !== undefined && !policies.includes(saved)) throw Error('Unknown saved audience.');
    const access = requested ?? saved ?? 'workspace';
    if (!policies.includes(access)) throw Error('Invalid audience.');
    if (saved !== undefined && access !== saved) throw Error('Replacement cannot change audience.');
    return access;
  }
  function requireCapability(value) {
    if (!value || value.version !== 3 || value.defaultAccessPolicy !== 'workspace'
      || value.replacementPreservesAccess !== true || value.internalCreatePath !== '/api/bench-share/internal' || !Array.isArray(value.accessPolicies)
      || !policies.every(p => value.accessPolicies.includes(p))) throw Error('Internal publishing support is unconfirmed. Nothing was created.');
  }
  async function publish({ request, upload, replace, payload, access, savedAccess, slug }) {
    const audience = selectAccess(access, savedAccess);
    if (audience !== 'public') requireCapability(await request('GET', '/api/bench-share'));
    if (slug) {
      if (savedAccess === undefined) throw Error('Replacement requires the saved audience.');
      const bundle = await request('GET', `/api/bench-share/${encodeURIComponent(slug)}/replace`);
      if (!bundle || bundle.accessPolicy !== audience) throw Error('Saved audience mismatch. No files sent.');
      const replaced = await replace(slug, audience);
      if (!replaced || replaced.accessPolicy !== audience) throw Error('Replacement audience echo missing or mismatched.');
      return links(slug, audience);
    }
    const created = await request('POST', audience === 'public' ? '/api/bench-share' : '/api/bench-share/internal', { ...payload, accessPolicy: audience });
    if (!created || created.accessPolicy !== audience || !/^[A-Za-z0-9_-]{22}$/.test(created.slug)) throw Error('Server audience echo missing or mismatched. No files uploaded.');
    await upload(created.slug);
    return links(created.slug, audience);
  }
  function links(slug, accessPolicy) {
    const forward = `/s/${encodeURIComponent(slug)}`;
    const look = accessPolicy === 'public' ? `/api/bench-share/${encodeURIComponent(slug)}/asset/index.html` : `/app/bench-pages/${encodeURIComponent(slug)}`;
    return { url: forward, forward, look, accessPolicy };
  }
  function mount(container, options) {
    const label = document.createElement('label');
    label.textContent = 'Audience ';
    const select = document.createElement('select');
    const labels = ['Internal — authorized workspace members', 'Internal — workspace managers and above', 'External — anyone with the link'];
    policies.forEach((p, i) => { const option = document.createElement('option'); option.value = p; option.textContent = labels[i]; select.append(option); });
    select.value = selectAccess(options.access, options.savedAccess);
    select.disabled = options.savedAccess !== undefined;
    label.append(select);
    const button = document.createElement('button'); button.textContent = 'Publish link'; button.type = 'button';
    const status = document.createElement('p'); status.setAttribute('role', 'status');
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const result = await publish({ ...options, access: select.value });
        status.textContent = `${labels[policies.indexOf(result.accessPolicy)]}: ${result.url}`;
        for (const [text, href] of [['Look', result.look], ['Forward', result.forward]]) {
          const link = document.createElement('a');
          link.textContent = text; link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer';
          status.append(' ', link);
        }
      }
      catch (error) { status.textContent = error.message; }
      finally { button.disabled = false; }
    });
    container.append(label, button, status);
    return { select, button, status };
  }
  const api = { selectAccess, requireCapability, publish, mount };
  if (typeof module !== 'undefined') module.exports = api;
  else root.BenchSharePublishControl = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
