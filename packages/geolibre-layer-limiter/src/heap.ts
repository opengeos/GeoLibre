/**
 * Binary Min-Heap for O(M log K) Top-K Selection
 */
export class MinHeap<T> {
  private heap: T[] = [];
  private compare: (a: T, b: T) => number;

  constructor(comparator: (a: T, b: T) => number) {
    this.compare = comparator;
  }

  size(): number {
    return this.heap.length;
  }

  peek(): T | null {
    return this.heap[0] ?? null;
  }

  push(item: T): void {
    this.heap.push(item);
    this.siftUp(this.heap.length - 1);
  }

  pop(): T | null {
    if (this.heap.length === 0) return null;
    const top = this.heap[0];
    const bottom = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = bottom;
      this.siftDown(0);
    }
    return top;
  }

  private siftUp(idx: number): void {
    while (idx > 0) {
      const parentIdx = (idx - 1) >> 1;
      if (this.compare(this.heap[idx], this.heap[parentIdx]) < 0) {
        const temp = this.heap[idx];
        this.heap[idx] = this.heap[parentIdx];
        this.heap[parentIdx] = temp;
        idx = parentIdx;
      } else {
        break;
      }
    }
  }

  private siftDown(idx: number): void {
    const length = this.heap.length;
    while ((idx << 1) + 1 < length) {
      let left = (idx << 1) + 1;
      let right = left + 1;
      let smallest = idx;

      if (this.compare(this.heap[left], this.heap[smallest]) < 0) {
        smallest = left;
      }
      if (right < length && this.compare(this.heap[right], this.heap[smallest]) < 0) {
        smallest = right;
      }
      if (smallest !== idx) {
        const temp = this.heap[idx];
        this.heap[idx] = this.heap[smallest];
        this.heap[smallest] = temp;
        idx = smallest;
      } else {
        break;
      }
    }
  }

  toArraySortedDescending(): T[] {
    const arr: T[] = [];
    while (this.size() > 0) {
      const item = this.pop();
      if (item !== null) {
        arr.push(item);
      }
    }
    return arr.reverse();
  }
}
