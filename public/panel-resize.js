export function rightPanelBounds(viewport, sidebar = 0) {
  const max = Math.max(280, viewport <= 1200 ? viewport - 24 : viewport - sidebar - 441);
  return { min: 280, max: Math.min(1000, max) };
}

export function createPanelResize({ handles, root, getSidebarWidth, window, storage }) {
  const key = 'codex-webui-right-panel-width';
  let preferred = null, drag = null;
  try { const stored = Number(storage?.getItem(key)); if (Number.isFinite(stored) && stored >= 280) preferred = stored; } catch {}
  const bounds = () => rightPanelBounds(window.innerWidth, getSidebarWidth());
  function apply(value = preferred, persist = false) {
    const { min, max } = bounds();
    if (value !== null) {
      const width = Math.round(Math.max(min, Math.min(max, value)));
      root.style.setProperty('--preferred-right-panel-w', `${width}px`);
      if (persist) { preferred = width; try { storage?.setItem(key, String(width)); } catch {} }
    }
    for (const handle of handles) {
      handle.tabIndex=window.innerWidth<=720||root.classList.contains('mobile-device')?-1:0;
      handle.setAttribute('aria-valuemin', String(min)); handle.setAttribute('aria-valuemax', String(max));
      handle.setAttribute('aria-valuenow', String(Math.max(min,Math.min(max,Math.round(handle.parentElement.getBoundingClientRect().width)))));
    }
  }
  function finish(event) {
    if (!drag || event.pointerId !== drag.id) return;
    drag = null; root.classList.remove('resizing-right-panel');
  }
  for (const handle of handles) {
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0 || window.innerWidth <= 720 || root.classList.contains('mobile-device')) return;
      event.preventDefault(); drag = { id: event.pointerId, x: event.clientX, width: handle.parentElement.getBoundingClientRect().width };
      handle.setPointerCapture(event.pointerId); root.classList.add('resizing-right-panel');
    });
    handle.addEventListener('pointermove', event => { if (drag?.id === event.pointerId) apply(drag.width + drag.x - event.clientX, true); });
    handle.addEventListener('pointerup', finish); handle.addEventListener('pointercancel', finish); handle.addEventListener('lostpointercapture', finish);
    handle.addEventListener('keydown', event => {
      if (window.innerWidth <= 720 || root.classList.contains('mobile-device')) return;
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const { min, max } = bounds(), width = handle.parentElement.getBoundingClientRect().width;
      apply(event.key === 'Home' ? min : event.key === 'End' ? max : width + (event.key === 'ArrowLeft' ? 20 : -20), true);
    });
  }
  window.addEventListener('resize', () => apply()); apply();
  return { refresh: () => apply() };
}
