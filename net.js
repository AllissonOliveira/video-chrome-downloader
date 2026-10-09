// Utilidades de rede compartilhadas (service worker e documento offscreen).

// Faz as requisições da extensão saírem com o mesmo Referer/Origin que o player usou.
// Só o service worker chama esta função (documentos offscreen não têm acesso a esta API).
export async function setHeaderRule(ruleId, referer, domains) {
  const removeRuleIds = [ruleId];
  if (!referer || !/^https?:/.test(referer) || !domains || !domains.length) {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds });
    return;
  }
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds,
    addRules: [
      {
        id: ruleId,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'referer', operation: 'set', value: referer },
            { header: 'origin', operation: 'set', value: new URL(referer).origin },
          ],
        },
        condition: {
          requestDomains: domains,
          tabIds: [chrome.tabs.TAB_ID_NONE],
          resourceTypes: ['xmlhttprequest', 'other'],
        },
      },
    ],
  });
}

export async function clearRule(ruleId) {
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
}

export async function fetchWithRetry(url, { range = null, signal, tries = 5, as = 'arrayBuffer' } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const headers = {};
      if (range) headers.Range = `bytes=${range.start}-${range.end}`;
      const res = await fetch(url, { headers, signal, credentials: 'include', cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return as === 'text' ? await res.text() : await res.arrayBuffer();
    } catch (e) {
      if (signal && signal.aborted) throw e;
      lastErr = e;
      await new Promise((r) => setTimeout(r, 600 * 2 ** attempt));
    }
  }
  throw lastErr;
}

export function sanitizeFilename(name) {
  const clean = (name || 'video')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|~]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 120)
    .trim();
  return clean || 'video';
}
