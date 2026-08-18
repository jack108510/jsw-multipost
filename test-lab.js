const $ = (id) => document.getElementById(id);

let identities = [];
let running = false;

function esc(value) {
  const el = document.createElement('span');
  el.textContent = value == null || value === '' ? '—' : String(value);
  return el.innerHTML;
}

function showStatus(kind, text) {
  const el = $('status');
  el.className = `status show ${kind}`;
  el.textContent = text;
}

function setBusy(busy) {
  running = busy;
  $('runBtn').disabled = busy;
  $('refreshBtn').disabled = busy;
  $('identitySelect').disabled = busy || identities.length === 0;
  $('groupUrl').disabled = busy;
  $('keepTabOpen').disabled = busy;
  $('runBtn').textContent = busy ? 'Testing identity…' : 'Run identity-switch test';
}

function identityLabel(identity) {
  const type = identity.type ? ` — ${identity.type}` : '';
  return `${identity.name || 'Unnamed identity'}${type}`;
}

function selectedIdentity() {
  return identities.find((identity) => String(identity.id || identity.url || identity.name) === $('identitySelect').value) || null;
}

function renderIdentities() {
  const select = $('identitySelect');
  if (!identities.length) {
    select.innerHTML = '<option value="">No synchronized Facebook identities found</option>';
    select.disabled = true;
    return;
  }

  select.innerHTML = identities.map((identity) => {
    const key = identity.id || identity.url || identity.name;
    return `<option value="${esc(key)}">${esc(identityLabel(identity))}</option>`;
  }).join('');
  select.disabled = running;
}

function renderResult(result) {
  const passed = !!result?.passed;
  const composerChecked = !!result?.composer_checked;
  const fields = [
    ['Overall result', `<span class="pill ${passed ? 'pass' : 'fail'}">${passed ? 'PASS' : 'FAIL'}</span>`],
    ['Expected identity', esc(result?.expected_identity)],
    ['Facebook active identity', esc(result?.active_identity)],
    ['Switch reported success', result?.switch_reported_success ? 'Yes' : 'No'],
    ['Active identity matches', result?.active_identity_matches ? 'Yes' : 'No'],
    ['Composer checked', composerChecked ? 'Yes' : 'No'],
    ['Composer identity', composerChecked ? esc(result?.composer_identity) : 'Not requested'],
    ['Composer matches', composerChecked ? (result?.composer_identity_matches ? 'Yes' : 'No') : 'Not requested'],
    ['Test page', result?.test_page_url ? `<a href="${esc(result.test_page_url)}" target="_blank" rel="noreferrer">Open in Facebook</a>` : '—'],
    ['Detail', esc(result?.error || result?.summary || 'No additional detail')]
  ];
  $('results').className = '';
  $('results').innerHTML = `<table class="result-table"><tbody>${fields.map(([label, value]) => `<tr><th>${esc(label)}</th><td>${value}</td></tr>`).join('')}</tbody></table>`;
}

async function refreshIdentities() {
  setBusy(true);
  showStatus('running', 'Loading synchronized Facebook identities…');
  try {
    const response = await chrome.runtime.sendMessage({ type: 'IDENTITY_TEST_LIST' });
    if (!response?.success) throw new Error(response?.error || 'Could not load synchronized identities.');
    identities = Array.isArray(response.identities) ? response.identities : [];
    renderIdentities();
    showStatus(identities.length ? 'pass' : 'fail', identities.length ? `${identities.length} identity${identities.length === 1 ? '' : 'ies'} available for testing.` : 'No identities found. Update profiles in the Reachr dashboard first.');
  } catch (error) {
    identities = [];
    renderIdentities();
    showStatus('fail', error.message || 'Could not load identities.');
  } finally {
    setBusy(false);
  }
}

async function runTest() {
  if (running) return;
  const identity = selectedIdentity();
  if (!identity) {
    showStatus('fail', 'Select a synchronized Facebook identity before testing.');
    return;
  }

  const groupUrl = $('groupUrl').value.trim();
  if (groupUrl && !/^https:\/\/(www\.)?facebook\.com\//i.test(groupUrl)) {
    showStatus('fail', 'Use a full https://www.facebook.com/... group URL, or leave the field blank for a switch-only test.');
    return;
  }

  setBusy(true);
  showStatus('running', groupUrl ? 'Testing the Page switch and group composer identity. No post will be created.' : 'Testing the Page switch. No post will be created.');
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'IDENTITY_TEST_RUN',
      identity,
      group_url: groupUrl || null,
      keep_tab_open: $('keepTabOpen').checked
    });
    if (!response?.success) throw new Error(response?.error || 'Identity test could not start.');
    renderResult(response.result);
    showStatus(response.result?.passed ? 'pass' : 'fail', response.result?.passed ? 'Identity test passed. No post was created.' : 'Identity test failed safely. No post was created.');
  } catch (error) {
    renderResult({ passed: false, expected_identity: identity.name, error: error.message || 'Identity test failed before verification.' });
    showStatus('fail', error.message || 'Identity test failed.');
  } finally {
    setBusy(false);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  $('refreshBtn').addEventListener('click', refreshIdentities);
  $('runBtn').addEventListener('click', runTest);
  refreshIdentities();
});
