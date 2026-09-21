/** Connected components by union-find: an edge in either direction joins. */
export class Components {
  private readonly parent = new Map<string, string>();

  add(node: string): void {
    if (!this.parent.has(node)) {
      this.parent.set(node, node);
    }
  }

  has(node: string): boolean {
    return this.parent.has(node);
  }

  find(node: string): string {
    let root = node;
    let next = this.parent.get(root);
    while (next !== undefined && next !== root) {
      root = next;
      next = this.parent.get(root);
    }
    if (next === undefined) {
      throw new Error(`not a node: ${node}`);
    }
    // path compression
    let cur = node;
    while (cur !== root) {
      const up = this.parent.get(cur) as string;
      this.parent.set(cur, root);
      cur = up;
    }
    return root;
  }

  union(a: string, b: string): void {
    this.add(a);
    this.add(b);
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) {
      // the smaller root wins, so that the representative is a function of the set and not of the order
      if (ra < rb) {
        this.parent.set(rb, ra);
      } else {
        this.parent.set(ra, rb);
      }
    }
  }

  /** Every node, grouped by component, each group sorted. */
  groups(): Map<string, string[]> {
    const groups = new Map<string, string[]>();
    for (const node of [...this.parent.keys()].sort()) {
      const root = this.find(node);
      const group = groups.get(root);
      if (group === undefined) {
        groups.set(root, [node]);
      } else {
        group.push(node);
      }
    }
    return groups;
  }
}
