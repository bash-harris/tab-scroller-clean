// welcome.js — Interactive Onboarding & Quick Setup

document.addEventListener('DOMContentLoaded', () => {
  // State
  const selectedConfig = {
    theme: 'dark',
    position: 'top',
    aiProvider: 'gemini'
  };

  // --- Interactive Live Playground ---
  const microbar = document.getElementById('microbar');
  const tabs = document.querySelectorAll('.micro-tab');
  const previewTitle = document.getElementById('previewTitle');
  const previewDomain = document.getElementById('previewDomain');
  const playground = document.getElementById('playground');

  let activeIndex = 0;

  function updateActiveTab(index) {
    if (index < 0) index = tabs.length - 1;
    if (index >= tabs.length) index = 0;
    activeIndex = index;

    tabs.forEach((tab, i) => {
      if (i === activeIndex) {
        tab.classList.add('active');
        previewTitle.textContent = tab.getAttribute('data-title');
        previewDomain.textContent = `(${tab.getAttribute('data-domain')})`;
      } else {
        tab.classList.remove('active');
      }
    });
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener('mouseenter', () => updateActiveTab(index));
    tab.addEventListener('click', () => updateActiveTab(index));
  });

  // Wheel scrolling inside playground
  if (playground) {
    playground.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.deltaY > 0) {
        updateActiveTab(activeIndex + 1);
      } else {
        updateActiveTab(activeIndex - 1);
      }
    }, { passive: false });
  }

  // --- Segmented Control Handlers ---
  function setupSegmentedControl(containerId, configKey, onSelect) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const buttons = container.querySelectorAll('.segmented-btn');
    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        buttons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const val = btn.getAttribute(`data-${configKey === 'position' ? 'pos' : configKey}`);
        if (val) {
          selectedConfig[configKey] = val;
          if (onSelect) onSelect(val);
        }
      });
    });
  }

  // Theme switch (live visual change)
  setupSegmentedControl('themeControl', 'theme', (theme) => {
    document.documentElement.setAttribute('data-theme', theme);
  });

  // Position switch
  setupSegmentedControl('positionControl', 'position');

  // AI Provider switch
  setupSegmentedControl('aiControl', 'aiProvider');

  // --- Load Existing Storage if Available ---
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
    chrome.storage.sync.get({ theme: 'dark', position: 'top', aiProvider: 'gemini' }, (items) => {
      if (items.theme) {
        selectedConfig.theme = items.theme;
        document.documentElement.setAttribute('data-theme', items.theme);
        const themeBtn = document.querySelector(`#themeControl [data-theme="${items.theme}"]`);
        if (themeBtn) {
          document.querySelectorAll('#themeControl .segmented-btn').forEach(b => b.classList.remove('active'));
          themeBtn.classList.add('active');
        }
      }
      if (items.position) {
        selectedConfig.position = items.position;
        const posBtn = document.querySelector(`#positionControl [data-pos="${items.position}"]`);
        if (posBtn) {
          document.querySelectorAll('#positionControl .segmented-btn').forEach(b => b.classList.remove('active'));
          posBtn.classList.add('active');
        }
      }
      if (items.aiProvider) {
        selectedConfig.aiProvider = items.aiProvider;
        const aiBtn = document.querySelector(`#aiControl [data-provider="${items.aiProvider}"]`);
        if (aiBtn) {
          document.querySelectorAll('#aiControl .segmented-btn').forEach(b => b.classList.remove('active'));
          aiBtn.classList.add('active');
        }
      }
    });
  }

  // --- CTA Get Started ---
  const getStartedBtn = document.getElementById('getStartedBtn');
  if (getStartedBtn) {
    getStartedBtn.addEventListener('click', () => {
      getStartedBtn.textContent = 'Saving Preferences...';
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
        chrome.storage.sync.set({
          theme: selectedConfig.theme,
          position: selectedConfig.position,
          aiProvider: selectedConfig.aiProvider,
          onboardingCompleted: true
        }, () => {
          window.location.href = 'options.html';
        });
      } else {
        window.location.href = 'options.html';
      }
    });
  }
});
