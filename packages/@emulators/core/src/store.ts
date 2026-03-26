export interface Entity {
  id: number;
  created_at: string;
  updated_at: string;
}

export type InsertInput<T extends Entity> = Omit<T, "id" | "created_at" | "updated_at"> & { id?: number };

export type FilterFn<T> = (item: T) => boolean;
export type SortFn<T> = (a: T, b: T) => number;

export interface QueryOptions<T> {
  filter?: FilterFn<T>;
  sort?: SortFn<T>;
  page?: number;
  per_page?: number;
}

export interface PaginatedResult<T> {
  items: T[];
  total_count: number;
  page: number;
  per_page: number;
  has_next: boolean;
  has_prev: boolean;
}

export class Collection<T extends Entity> {
  private items = new Map<number, T>();
  private indexes = new Map<string, Map<string | number, Set<number>>>();
  private autoId = 1;
  readonly fieldNames: string[];

  constructor(private indexFields: (keyof T)[] = []) {
    this.fieldNames = indexFields.map(String).sort();
    for (const field of indexFields) {
      this.indexes.set(String(field), new Map());
    }
  }

  private addToIndex(item: T): void {
    for (const field of this.indexFields) {
      const value = item[field];
      if (value === undefined || value === null) continue;
      const indexMap = this.indexes.get(String(field))!;
      const key = String(value);
      if (!indexMap.has(key)) {
        indexMap.set(key, new Set());
      }
      indexMap.get(key)!.add(item.id);
    }
  }

  private removeFromIndex(item: T): void {
    for (const field of this.indexFields) {
      const value = item[field];
      if (value === undefined || value === null) continue;
      const indexMap = this.indexes.get(String(field))!;
      const key = String(value);
      indexMap.get(key)?.delete(item.id);
    }
  }

  insert(data: InsertInput<T>): T {
    const now = new Date().toISOString();
    const explicitId = data.id != null && data.id > 0 ? data.id : undefined;
    const id = explicitId ?? this.autoId++;
    if (id >= this.autoId) {
      this.autoId = id + 1;
    }
    const item = {
      ...data,
      id,
      created_at: now,
      updated_at: now,
    } as unknown as T;
    this.items.set(id, item);
    this.addToIndex(item);
    return item;
  }

  get(id: number): T | undefined {
    return this.items.get(id);
  }

  findBy(field: keyof T, value: T[keyof T] | string | number): T[] {
    if (this.indexes.has(String(field))) {
      const ids = this.indexes.get(String(field))!.get(String(value));
      if (!ids) return [];
      return Array.from(ids).map((id) => this.items.get(id)!).filter(Boolean);
    }
    return this.all().filter((item) => item[field] === value);
  }

  findOneBy(field: keyof T, value: T[keyof T] | string | number): T | undefined {
    return this.findBy(field, value)[0];
  }

  update(id: number, data: Partial<T>): T | undefined {
    const existing = this.items.get(id);
    if (!existing) return undefined;
    this.removeFromIndex(existing);
    const updated = {
      ...existing,
      ...data,
      id,
      updated_at: new Date().toISOString(),
    } as T;
    this.items.set(id, updated);
    this.addToIndex(updated);
    return updated;
  }

  delete(id: number): boolean {
    const existing = this.items.get(id);
    if (!existing) return false;
    this.removeFromIndex(existing);
    return this.items.delete(id);
  }

  all(): T[] {
    return Array.from(this.items.values());
  }

  query(options: QueryOptions<T> = {}): PaginatedResult<T> {
    let results = this.all();

    if (options.filter) {
      results = results.filter(options.filter);
    }

    const total_count = results.length;

    if (options.sort) {
      results.sort(options.sort);
    }

    const page = options.page ?? 1;
    const per_page = Math.min(options.per_page ?? 30, 100);
    const start = (page - 1) * per_page;
    const paged = results.slice(start, start + per_page);

    return {
      items: paged,
      total_count,
      page,
      per_page,
      has_next: start + per_page < total_count,
      has_prev: page > 1,
    };
  }

  count(filter?: FilterFn<T>): number {
    if (!filter) return this.items.size;
    return this.all().filter(filter).length;
  }

  clear(): void {
    this.items.clear();
    for (const indexMap of this.indexes.values()) {
      indexMap.clear();
    }
    this.autoId = 1;
  }
}

export class Store {
  private collections = new Map<string, Collection<any>>();
  private _data = new Map<string, unknown>();

  collection<T extends Entity>(name: string, indexFields: (keyof T)[] = []): Collection<T> {
    const existing = this.collections.get(name);
    if (existing) {
      if (indexFields.length > 0) {
        const requested = indexFields.map(String).sort();
        if (existing.fieldNames.length !== requested.length || existing.fieldNames.some((f, i) => f !== requested[i])) {
          throw new Error(
            `Collection "${name}" already exists with indexes [${existing.fieldNames}] but was requested with [${requested}]`
          );
        }
      }
      return existing as Collection<T>;
    }
    const col = new Collection<T>(indexFields);
    this.collections.set(name, col);
    return col;
  }

  getData<V>(key: string): V | undefined {
    return this._data.get(key) as V | undefined;
  }

  setData<V>(key: string, value: V): void {
    this._data.set(key, value);
  }

  reset(): void {
    for (const collection of this.collections.values()) {
      collection.clear();
    }
    this._data.clear();
  }
}
