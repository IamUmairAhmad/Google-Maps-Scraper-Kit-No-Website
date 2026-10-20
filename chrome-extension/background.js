// Clicking the toolbar icon opens the search page, or focuses it if it is already open.
async function openApp() {
  const pageUrl = chrome.runtime.getURL("app.html");
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["TAB"] });
    const existing = contexts.find((context) => context.documentUrl === pageUrl && context.tabId >= 0);
    if (existing) {
      const tab = await chrome.tabs.update(existing.tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return;
    }
  } catch {
    // Fall through and open a new tab.
  }
  await chrome.tabs.create({ url: pageUrl });
}

chrome.action.onClicked.addListener(openApp);
globalThis.openApp = openApp; // lets tests call it directly
