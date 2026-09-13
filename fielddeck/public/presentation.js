(() => {
  const slides = [...document.querySelectorAll('.export-slide')];
  let current = 0;
  const prev = document.getElementById('prev-slide');
  const next = document.getElementById('next-slide');
  const toggle = document.getElementById('toggle-overview');
  function show(index) {
    current = Math.max(0, Math.min(slides.length - 1, index));
    slides.forEach((s, i) => s.classList.toggle('active', i === current));
    document.getElementById('present-counter').textContent = `${current + 1} / ${slides.length}`;
    prev.disabled = current === 0;
    next.disabled = current === slides.length - 1;
  }
  function overview(on) {
    document.body.classList.toggle('overview', on);
    toggle.textContent = on ? 'Present' : 'Overview';
    toggle.setAttribute('aria-pressed', String(on));
  }
  prev.addEventListener('click', () => show(current - 1));
  next.addEventListener('click', () => show(current + 1));
  toggle.addEventListener('click', () => overview(!document.body.classList.contains('overview')));
  document.getElementById('print-deck').addEventListener('click', () => window.print());
  document.addEventListener('keydown', event => {
    if (event.ctrlKey || event.metaKey || event.altKey || /INPUT|TEXTAREA|SELECT|BUTTON/.test(event.target.tagName)) return;
    if (['ArrowRight', 'PageDown', ' '].includes(event.key)) { event.preventDefault(); show(current + 1); }
    if (['ArrowLeft', 'PageUp'].includes(event.key)) { event.preventDefault(); show(current - 1); }
    if (event.key === 'Home') { event.preventDefault(); show(0); }
    if (event.key === 'End') { event.preventDefault(); show(slides.length - 1); }
    if (event.key === 'Escape') overview(true);
    if (event.key.toLowerCase() === 'o') overview(!document.body.classList.contains('overview'));
  });
  slides.forEach((s, i) => s.addEventListener('click', () => { if (document.body.classList.contains('overview')) { show(i); overview(false); } }));
  show(0);
})();
