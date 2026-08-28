import type { EventInfo, StacItem, ItemProperties } from './types';
import { formatDate } from './utils';
import { StacClient } from './stac-client';

export type PanelEventType =
  | 'search'
  | 'refresh'
  | 'draw-bbox'
  | 'clear-bbox'
  | 'row-click'
  | 'visualize'
  | 'download'
  | 'cancel-download'
  | 'select-all'
  | 'deselect-all';

export interface PanelEventDetail {
  type: PanelEventType;
  eventUrl?: string;
  phase?: string;
  useMapExtent?: boolean;
  itemId?: string;
  items?: StacItem[];
}

type StatusType = 'info' | 'success' | 'warning' | 'error';

interface SortState {
  column: number;
  direction: 'asc' | 'desc';
}

const stacClient = new StacClient();

export class PanelUI extends EventTarget {
  private root: HTMLElement;
  private items: StacItem[] = [];
  private sortState: SortState | null = null;

  // DOM references
  private panelDiv!: HTMLDivElement;
  private contentDiv!: HTMLDivElement;
  private toggleBtn!: HTMLButtonElement;
  private eventSelect!: HTMLSelectElement;
  private phaseSelect!: HTMLSelectElement;
  private useExtentCheckbox!: HTMLInputElement;
  private drawBBoxBtn!: HTMLButtonElement;
  private clearBBoxBtn!: HTMLButtonElement;
  private bboxInfo!: HTMLSpanElement;
  private searchBtn!: HTMLButtonElement;
  private countLabel!: HTMLSpanElement;
  private tableContainer!: HTMLDivElement;
  private table!: HTMLTableElement;
  private thead!: HTMLTableSectionElement;
  private tbody!: HTMLTableSectionElement;
  private visualizeBtn!: HTMLButtonElement;
  private downloadBtn!: HTMLButtonElement;
  private progressContainer!: HTMLDivElement;
  private progressBar!: HTMLDivElement;
  private cancelBtn!: HTMLButtonElement;
  private statusDiv!: HTMLDivElement;

  private collapsed: boolean;
  private panelWidth?: number;
  private maxHeight?: number | string;
  private theme: 'auto' | 'light' | 'dark';

  constructor(
    container: HTMLElement,
    collapsed = false,
    panelWidth?: number,
    maxHeight?: number | string,
    theme: 'auto' | 'light' | 'dark' = 'auto',
  ) {
    super();
    this.root = container;
    this.collapsed = collapsed;
    this.panelWidth = panelWidth;
    this.maxHeight = maxHeight;
    this.theme = theme;
    this.buildUI();
  }

  private buildUI(): void {
    this.panelDiv = this.el('div', 'vantor-panel');
    this.panelDiv.classList.add(`vantor-panel--theme-${this.theme}`);
    if (this.collapsed) {
      this.panelDiv.classList.add('vantor-panel--collapsed');
    }
    if (this.panelWidth) {
      this.panelDiv.style.setProperty('--vantor-panel-width', `${this.panelWidth}px`);
    }
    if (this.maxHeight !== undefined) {
      const val = typeof this.maxHeight === 'number' ? `${this.maxHeight}px` : this.maxHeight;
      this.panelDiv.style.setProperty('--vantor-panel-max-height', val);
    }

    // Toggle button (close X) — only visible when expanded
    this.toggleBtn = this.el('button', 'vantor-panel__toggle');
    this.toggleBtn.type = 'button';
    this.toggleBtn.innerHTML = '&#10005;';
    this.toggleBtn.title = 'Collapse panel';
    this.toggleBtn.addEventListener('click', () => {
      this.collapsed = true;
      this.panelDiv.classList.add('vantor-panel--collapsed');
    });
    this.panelDiv.appendChild(this.toggleBtn);

    // Open button — only visible when collapsed
    const openBtn = this.el('button', 'vantor-panel__open-btn');
    openBtn.type = 'button';
    openBtn.setAttribute('aria-label', 'Open Vantor STAC Explorer');
    const openIcon = this.el('span', 'maplibregl-ctrl-icon vantor-panel__open-icon');
    openIcon.setAttribute('aria-hidden', 'true');
    openBtn.appendChild(openIcon);
    openBtn.title = 'Open Vantor STAC Explorer';
    openBtn.addEventListener('click', () => {
      this.collapsed = false;
      this.panelDiv.classList.remove('vantor-panel--collapsed');
    });
    this.panelDiv.appendChild(openBtn);

    // Content wrapper
    this.contentDiv = this.el('div', 'vantor-panel__content');

    // Header
    const header = this.el('div', 'vantor-panel__header');
    const h3 = document.createElement('h3');
    h3.textContent = 'Vantor STAC Explorer';
    header.appendChild(h3);
    this.contentDiv.appendChild(header);

    // Search section
    this.buildSearchSection();

    // Results section
    this.buildResultsSection();

    // Actions
    this.buildActionsSection();

    // Progress
    this.buildProgressSection();

    // Status
    this.statusDiv = this.el('div', 'vantor-panel__status');
    this.statusDiv.textContent = 'Ready';
    this.contentDiv.appendChild(this.statusDiv);

    this.panelDiv.appendChild(this.contentDiv);

    // Resize handles (bottom-left and bottom-right corners)
    this.buildResizeHandles();

    this.root.appendChild(this.panelDiv);
  }

  private buildResizeHandles(): void {
    const left = this.el(
      'div',
      'vantor-panel__resize-handle vantor-panel__resize-handle--bl',
    );
    const right = this.el(
      'div',
      'vantor-panel__resize-handle vantor-panel__resize-handle--br',
    );
    left.setAttribute('aria-hidden', 'true');
    right.setAttribute('aria-hidden', 'true');
    this.attachResize(left, 'left');
    this.attachResize(right, 'right');
    this.panelDiv.appendChild(left);
    this.panelDiv.appendChild(right);
  }

  private attachResize(handle: HTMLElement, side: 'left' | 'right'): void {
    const MIN_W = 280;
    const MIN_H = 220;
    const clamp = (v: number, lo: number, hi: number) =>
      Math.max(lo, Math.min(hi, v));

    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startY = e.clientY;
      const rect = this.panelDiv.getBoundingClientRect();
      const startW = rect.width;
      const startH = rect.height;
      handle.setPointerCapture(e.pointerId);
      this.panelDiv.classList.add('vantor-panel--resizing');

      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        // Bottom-right widens on rightward drag; bottom-left on leftward drag.
        const dw = side === 'right' ? dx : -dx;
        const maxW = Math.max(MIN_W, window.innerWidth - 20);
        const maxH = Math.max(MIN_H, window.innerHeight - 40);
        const newW = clamp(startW + dw, MIN_W, maxW);
        const newH = clamp(startH + dy, MIN_H, maxH);
        this.panelDiv.classList.add('vantor-panel--resized');
        this.panelDiv.style.setProperty('--vantor-panel-width', `${newW}px`);
        this.panelDiv.style.setProperty('--vantor-panel-height', `${newH}px`);
      };
      const onUp = (ev: PointerEvent) => {
        handle.releasePointerCapture(ev.pointerId);
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        this.panelDiv.classList.remove('vantor-panel--resizing');
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
    });
  }

  private buildSearchSection(): void {
    const section = this.el('div', 'vantor-panel__search');

    const title = this.el('div', 'vantor-panel__section-title');
    title.textContent = 'Search';
    section.appendChild(title);

    // Event selector
    const eventField = this.el('div', 'vantor-panel__field');
    const eventLabel = document.createElement('label');
    eventLabel.textContent = 'Event';
    eventField.appendChild(eventLabel);

    const eventRow = this.el('div', 'vantor-panel__select-row');
    this.eventSelect = document.createElement('select');
    this.eventSelect.innerHTML = '<option value="">Loading events...</option>';
    eventRow.appendChild(this.eventSelect);

    const refreshBtn = this.el('button', 'vantor-panel__btn vantor-panel__btn--refresh');
    refreshBtn.type = 'button';
    refreshBtn.innerHTML = '&#8635;';
    refreshBtn.title = 'Refresh catalog';
    refreshBtn.addEventListener('click', () => this.emit('refresh'));
    eventRow.appendChild(refreshBtn);

    eventField.appendChild(eventRow);
    section.appendChild(eventField);

    // Phase filter
    const phaseField = this.el('div', 'vantor-panel__field');
    const phaseLabel = document.createElement('label');
    phaseLabel.textContent = 'Phase';
    phaseField.appendChild(phaseLabel);

    this.phaseSelect = document.createElement('select');
    for (const [value, text] of [
      ['all', 'All'],
      ['pre', 'Pre-event'],
      ['post', 'Post-event'],
    ] as const) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = text;
      this.phaseSelect.appendChild(opt);
    }
    phaseField.appendChild(this.phaseSelect);
    section.appendChild(phaseField);

    // Spatial filter
    const spatialField = this.el('div', 'vantor-panel__field');
    this.useExtentCheckbox = document.createElement('input');
    this.useExtentCheckbox.type = 'checkbox';

    const checkLabel = this.el('label', 'vantor-panel__checkbox-label');
    checkLabel.appendChild(this.useExtentCheckbox);
    const checkSpan = document.createElement('span');
    checkSpan.textContent = 'Use Map Extent';
    checkLabel.appendChild(checkSpan);
    spatialField.appendChild(checkLabel);
    section.appendChild(spatialField);

    // BBox controls
    const bboxControls = this.el('div', 'vantor-panel__bbox-controls');

    this.drawBBoxBtn = this.el('button', 'vantor-panel__btn vantor-panel__btn--small');
    this.drawBBoxBtn.type = 'button';
    this.drawBBoxBtn.textContent = 'Draw BBox';
    this.drawBBoxBtn.addEventListener('click', () => {
      this.drawBBoxBtn.classList.toggle('vantor-panel__btn--active');
      this.emit('draw-bbox');
    });
    bboxControls.appendChild(this.drawBBoxBtn);

    this.clearBBoxBtn = this.el('button', 'vantor-panel__btn vantor-panel__btn--small');
    this.clearBBoxBtn.type = 'button';
    this.clearBBoxBtn.textContent = 'Clear';
    this.clearBBoxBtn.disabled = true;
    this.clearBBoxBtn.addEventListener('click', () => {
      this.emit('clear-bbox');
    });
    bboxControls.appendChild(this.clearBBoxBtn);

    section.appendChild(bboxControls);

    this.bboxInfo = this.el('span', 'vantor-panel__bbox-info') as HTMLSpanElement;
    section.appendChild(this.bboxInfo);

    // Search button
    this.searchBtn = this.el('button', 'vantor-panel__btn vantor-panel__btn--primary');
    this.searchBtn.type = 'button';
    this.searchBtn.textContent = 'Search';
    this.searchBtn.addEventListener('click', () => this.emit('search'));
    section.appendChild(this.searchBtn);

    this.contentDiv.appendChild(section);
  }

  private buildResultsSection(): void {
    const section = this.el('div', 'vantor-panel__results');

    const title = this.el('div', 'vantor-panel__section-title');
    title.textContent = 'Results';
    section.appendChild(title);

    // Header row
    const headerRow = this.el('div', 'vantor-panel__results-header');
    this.countLabel = document.createElement('span');
    this.countLabel.className = 'vantor-panel__count';
    this.countLabel.textContent = '0 item(s) found';
    headerRow.appendChild(this.countLabel);

    const selectControls = this.el('div', 'vantor-panel__select-controls');
    const selectAllBtn = this.el('button', 'vantor-panel__btn vantor-panel__btn--small');
    selectAllBtn.type = 'button';
    selectAllBtn.textContent = 'Select All';
    selectAllBtn.addEventListener('click', () => {
      this.setAllChecked(true);
      this.emit('select-all');
    });
    selectControls.appendChild(selectAllBtn);

    const deselectAllBtn = this.el('button', 'vantor-panel__btn vantor-panel__btn--small');
    deselectAllBtn.type = 'button';
    deselectAllBtn.textContent = 'Deselect All';
    deselectAllBtn.addEventListener('click', () => {
      this.setAllChecked(false);
      this.emit('deselect-all');
    });
    selectControls.appendChild(deselectAllBtn);

    headerRow.appendChild(selectControls);
    section.appendChild(headerRow);

    // Table
    this.tableContainer = this.el('div', 'vantor-panel__table-container');
    this.table = document.createElement('table');
    this.table.className = 'vantor-panel__table';

    this.thead = document.createElement('thead');
    const headerTr = document.createElement('tr');
    const columns = ['', 'ID', 'Date', 'Phase', 'Sensor', 'Cloud%', 'GSD'];
    columns.forEach((col, idx) => {
      const th = document.createElement('th');
      th.textContent = col;
      if (idx > 0) {
        th.addEventListener('click', () => this.sortByColumn(idx));
      }
      headerTr.appendChild(th);
    });
    this.thead.appendChild(headerTr);
    this.table.appendChild(this.thead);

    this.tbody = document.createElement('tbody');
    this.table.appendChild(this.tbody);

    this.tableContainer.appendChild(this.table);
    section.appendChild(this.tableContainer);

    this.contentDiv.appendChild(section);
  }

  private buildActionsSection(): void {
    const section = this.el('div', 'vantor-panel__actions');

    this.visualizeBtn = this.el('button', 'vantor-panel__btn vantor-panel__btn--success');
    this.visualizeBtn.type = 'button';
    this.visualizeBtn.textContent = 'Visualize';
    this.visualizeBtn.addEventListener('click', () => this.emit('visualize'));
    section.appendChild(this.visualizeBtn);

    this.downloadBtn = this.el('button', 'vantor-panel__btn vantor-panel__btn--warning');
    this.downloadBtn.type = 'button';
    this.downloadBtn.textContent = 'Download';
    this.downloadBtn.addEventListener('click', () => this.emit('download'));
    section.appendChild(this.downloadBtn);

    this.contentDiv.appendChild(section);
  }

  private buildProgressSection(): void {
    this.progressContainer = this.el('div', 'vantor-panel__progress-container');

    const progressTrack = this.el('div', 'vantor-panel__progress');
    this.progressBar = this.el('div', 'vantor-panel__progress-bar');
    this.progressBar.style.width = '0%';
    progressTrack.appendChild(this.progressBar);
    this.progressContainer.appendChild(progressTrack);

    this.cancelBtn = this.el('button', 'vantor-panel__btn vantor-panel__btn--small');
    this.cancelBtn.type = 'button';
    this.cancelBtn.textContent = 'Cancel';
    this.cancelBtn.addEventListener('click', () => this.emit('cancel-download'));
    this.progressContainer.appendChild(this.cancelBtn);

    this.contentDiv.appendChild(this.progressContainer);
  }

  // -- Public methods --

  setEvents(events: EventInfo[]): void {
    this.eventSelect.innerHTML = '';
    if (events.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No events found';
      this.eventSelect.appendChild(opt);
    } else {
      for (const event of events) {
        const opt = document.createElement('option');
        opt.value = event.href;
        opt.textContent = event.title;
        this.eventSelect.appendChild(opt);
      }
    }
  }

  setItems(items: StacItem[]): void {
    this.items = items;
    this.sortState = null;
    this.countLabel.textContent = `${items.length} item(s) found`;
    this.renderTable(items);
  }

  getSelectedEventUrl(): string {
    return this.eventSelect.value;
  }

  getPhase(): string {
    return this.phaseSelect.value;
  }

  isUseMapExtent(): boolean {
    return this.useExtentCheckbox.checked;
  }

  setBBoxInfo(text: string): void {
    this.bboxInfo.textContent = text;
    this.clearBBoxBtn.disabled = !text;
  }

  setDrawBBoxActive(active: boolean): void {
    this.drawBBoxBtn.classList.toggle('vantor-panel__btn--active', active);
  }

  getCheckedItems(): StacItem[] {
    const checked: StacItem[] = [];
    const checkboxes = this.tbody.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    checkboxes.forEach((cb) => {
      if (cb.checked) {
        const itemId = cb.dataset.itemId;
        const item = this.items.find((i) => i.id === itemId);
        if (item) checked.push(item);
      }
    });
    return checked;
  }

  highlightRow(itemId: string): void {
    // Remove previous highlight
    const prev = this.tbody.querySelector('.vantor-panel__table-row--highlighted');
    if (prev) prev.classList.remove('vantor-panel__table-row--highlighted');

    // Find and highlight
    const rows = this.tbody.querySelectorAll('tr');
    for (const row of rows) {
      if (row.dataset.itemId === itemId) {
        row.classList.add('vantor-panel__table-row--highlighted');
        this.scrollRowIntoView(row);
        break;
      }
    }
  }

  /**
   * Scroll the results table container so `row` is visible, accounting for the
   * sticky table header. Scrolls only the table container (not the page), which
   * `Element.scrollIntoView({ block: 'nearest' })` does not do reliably here.
   */
  private scrollRowIntoView(row: HTMLElement): void {
    const container = this.tableContainer;
    const cRect = container.getBoundingClientRect();
    const rRect = row.getBoundingClientRect();
    // The header is sticky, so the usable top of the viewport sits below it.
    const headerH = this.thead.getBoundingClientRect().height;
    // clientTop/clientHeight exclude the border and the horizontal scrollbar, so
    // the usable bottom sits above the scrollbar (which would otherwise clip the
    // row we scroll to).
    const viewTop = cRect.top + container.clientTop + headerH;
    const viewBottom = cRect.top + container.clientTop + container.clientHeight;

    const deltaTop = rRect.top - viewTop;
    const deltaBottom = rRect.bottom - viewBottom;

    if (deltaTop < 0) {
      container.scrollBy({ top: deltaTop, behavior: 'smooth' });
    } else if (deltaBottom > 0) {
      container.scrollBy({ top: deltaBottom, behavior: 'smooth' });
    }
  }

  /** Check or uncheck a result row's selection checkbox by item id. */
  setRowChecked(itemId: string, checked: boolean): void {
    const checkbox = this.tbody.querySelector<HTMLInputElement>(
      `input[type="checkbox"][data-item-id="${CSS.escape(itemId)}"]`,
    );
    if (checkbox) checkbox.checked = checked;
  }

  setLoading(loading: boolean): void {
    this.searchBtn.disabled = loading;
    this.searchBtn.textContent = loading ? 'Searching...' : 'Search';
  }

  setStatus(message: string, type: StatusType = 'info'): void {
    this.statusDiv.textContent = message;
    this.statusDiv.className = `vantor-panel__status vantor-panel__status--${type}`;
  }

  setTheme(theme: 'auto' | 'light' | 'dark'): void {
    this.panelDiv.classList.remove(
      'vantor-panel--theme-auto',
      'vantor-panel--theme-light',
      'vantor-panel--theme-dark',
    );
    this.theme = theme;
    this.panelDiv.classList.add(`vantor-panel--theme-${theme}`);
  }

  setProgress(value: number): void {
    if (value < 0) {
      this.progressContainer.classList.remove('vantor-panel__progress-container--visible');
    } else {
      this.progressContainer.classList.add('vantor-panel__progress-container--visible');
      this.progressBar.style.width = `${Math.min(100, Math.max(0, value))}%`;
    }
  }

  setDownloading(downloading: boolean): void {
    this.downloadBtn.disabled = downloading;
    this.visualizeBtn.disabled = downloading;
    if (!downloading) {
      this.setProgress(-1);
    }
  }

  // -- Private methods --

  private renderTable(items: StacItem[]): void {
    this.tbody.innerHTML = '';

    for (const item of items) {
      const props = stacClient.getItemProperties(item);
      const tr = document.createElement('tr');
      tr.dataset.itemId = item.id;

      tr.addEventListener('click', (e) => {
        // Don't trigger row click when clicking checkbox
        if ((e.target as HTMLElement).tagName === 'INPUT') return;
        this.emit('row-click', item.id);
      });

      // Checkbox
      const tdCheck = document.createElement('td');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.dataset.itemId = item.id;
      checkbox.addEventListener('click', (e) => e.stopPropagation());
      tdCheck.appendChild(checkbox);
      tr.appendChild(tdCheck);

      // ID
      tr.appendChild(this.createTd(props.id));

      // Date
      tr.appendChild(this.createTd(formatDate(props.datetime)));

      // Phase
      const phaseTd = this.createTd(props.phase);
      if (props.phase === 'pre') phaseTd.classList.add('vantor-phase--pre');
      if (props.phase === 'post') phaseTd.classList.add('vantor-phase--post');
      tr.appendChild(phaseTd);

      // Sensor
      tr.appendChild(this.createTd(props.sensor));

      // Cloud cover
      const cc = props.cloud_cover;
      tr.appendChild(this.createTd(typeof cc === 'number' ? cc.toFixed(1) : String(cc)));

      // GSD
      const gsd = props.pan_gsd;
      tr.appendChild(
        this.createTd(typeof gsd === 'number' ? gsd.toFixed(2) : String(gsd)),
      );

      this.tbody.appendChild(tr);
    }
  }

  private createTd(text: string): HTMLTableCellElement {
    const td = document.createElement('td');
    td.textContent = text;
    td.title = text;
    return td;
  }

  private sortByColumn(colIdx: number): void {
    if (this.items.length === 0) return;

    // Toggle direction
    if (this.sortState?.column === colIdx) {
      this.sortState.direction = this.sortState.direction === 'asc' ? 'desc' : 'asc';
    } else {
      this.sortState = { column: colIdx, direction: 'asc' };
    }

    // Update header classes
    const ths = this.thead.querySelectorAll('th');
    ths.forEach((th) => {
      th.classList.remove('vantor-sort-asc', 'vantor-sort-desc');
    });
    ths[colIdx].classList.add(
      this.sortState.direction === 'asc' ? 'vantor-sort-asc' : 'vantor-sort-desc',
    );

    // Sort items
    const propKeys: (keyof ItemProperties)[] = [
      'id',
      'id',
      'datetime',
      'phase',
      'sensor',
      'cloud_cover',
      'pan_gsd',
    ];
    const key = propKeys[colIdx];
    const dir = this.sortState.direction === 'asc' ? 1 : -1;

    const sorted = [...this.items].sort((a, b) => {
      const propsA = stacClient.getItemProperties(a);
      const propsB = stacClient.getItemProperties(b);
      const va = propsA[key];
      const vb = propsB[key];

      if (typeof va === 'number' && typeof vb === 'number') {
        return (va - vb) * dir;
      }
      return String(va).localeCompare(String(vb)) * dir;
    });

    this.renderTable(sorted);
  }

  private setAllChecked(checked: boolean): void {
    const checkboxes = this.tbody.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    checkboxes.forEach((cb) => {
      cb.checked = checked;
    });
  }

  private emit(type: PanelEventType, itemId?: string): void {
    this.dispatchEvent(
      new CustomEvent<PanelEventDetail>('panel-action', {
        detail: {
          type,
          eventUrl: this.eventSelect.value,
          phase: this.phaseSelect.value,
          useMapExtent: this.useExtentCheckbox.checked,
          itemId,
        },
      }),
    );
  }

  private el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className: string,
  ): HTMLElementTagNameMap[K] {
    const element = document.createElement(tag);
    element.className = className;
    return element;
  }
}
