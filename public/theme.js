// Apply before the first paint on both the sign-in page and the workspace.
(() => {
  const key = 'jobintel.appearance';
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  let choice = 'system';
  function read() {
    try { choice = localStorage.getItem(key) || 'system'; } catch {}
    if (!['system', 'light', 'dark'].includes(choice)) choice = 'system';
  }
  function apply() {
    document.documentElement.dataset.theme = choice === 'system' ? (system.matches ? 'dark' : 'light') : choice;
    const select = document.getElementById('appearance');
    if (select) select.value = choice;
  }
  read();
  apply();
  system.addEventListener('change', apply);
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) { read(); apply(); }
  });
  document.addEventListener('DOMContentLoaded', () => {
    const select = document.getElementById('appearance');
    select.value = choice;
    select.addEventListener('change', () => {
      choice = select.value;
      try { localStorage.setItem(key, choice); } catch {}
      apply();
    });
  });
})();
