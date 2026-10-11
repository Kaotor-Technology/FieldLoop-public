// Fragment navigation opens the containing disclosure before moving focus.
function revealReference() {
  const target = document.getElementById(location.hash.slice(1));
  if (!target) return;
  for (let parent = target.parentElement; parent; parent = parent.parentElement) {
    if (parent instanceof HTMLDetailsElement) parent.open = true;
  }
  target.tabIndex = -1;
  target.focus({ preventScroll: true });
  target.scrollIntoView();
}
addEventListener("hashchange", revealReference);
revealReference();
