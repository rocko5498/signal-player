// ============================================================
// virtual-list.js — windowed renderer for the track list.
//
// Only ~overscan more rows than fit in the viewport are kept in
// the DOM. Recycles row elements on scroll.
// ============================================================

const ROW_HEIGHT = 56;
const OVERSCAN = 6;

export class VirtualList {
  constructor({ scroller, spacer, rows, renderRow }) {
    this.scroller = scroller;
    this.spacer = spacer;
    this.rows = rows;
    this.renderRow = renderRow;
    this.items = [];
    this.pool = [];
    this.activeCount = 0;
    this.scheduledFrame = false;

    this.scroller.addEventListener('scroll', () => this._schedule(), { passive: true });
    window.addEventListener('resize', () => this._schedule());
  }

  setItems(items) {
    this.items = items;
    this.spacer.style.height = (items.length * ROW_HEIGHT) + 'px';
    this._schedule();
  }

  refresh() { this._schedule(); }

  _schedule() {
    if (this.scheduledFrame) return;
    this.scheduledFrame = true;
    requestAnimationFrame(() => {
      this.scheduledFrame = false;
      this._render();
    });
  }

  _render() {
    const scrollTop = this.scroller.scrollTop;
    const viewportH = this.scroller.clientHeight;
    const firstVisible = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const lastVisible = Math.min(
      this.items.length - 1,
      Math.ceil((scrollTop + viewportH) / ROW_HEIGHT) + OVERSCAN
    );
    const needed = Math.max(0, lastVisible - firstVisible + 1);

    // Grow pool if needed
    while (this.pool.length < needed) {
      const el = document.createElement('div');
      el.className = 'track';
      this.rows.appendChild(el);
      this.pool.push(el);
    }

    // Hide extra rows
    for (let i = needed; i < this.activeCount; i++) {
      this.pool[i].style.display = 'none';
    }

    // Render visible
    for (let i = 0; i < needed; i++) {
      const itemIdx = firstVisible + i;
      const el = this.pool[i];
      el.style.display = '';
      el.style.transform = `translateY(${itemIdx * ROW_HEIGHT}px)`;
      el.dataset.idx = itemIdx;
      this.renderRow(el, this.items[itemIdx], itemIdx);
    }
    this.activeCount = needed;
  }

  scrollToIndex(idx) {
    if (idx < 0) return;
    this.scroller.scrollTop = idx * ROW_HEIGHT - this.scroller.clientHeight / 3;
  }
}
