export type DatabaseItem = {
  id: string;
  content: string;
  section: string;
  groupName: string;
  url: string | null;
  links: string;
  note: string;
  parentId: string | null;
  priority: string;
  dueDate: string | null;
  completed: boolean;
  archived: boolean;
  archivedAt: string | null;
  position: number;
  indent: number;
  bold: boolean;
  createdAt: string;
  updatedAt: string;
};

export type DatabaseChanges = Partial<
  Omit<DatabaseItem, "id" | "createdAt">
>;

export interface WorkspaceRepository {
  ensure(): Promise<void>;
  count(): Promise<number>;
  list(): Promise<DatabaseItem[]>;
  maxPosition(section: string, groupName: string): Promise<number>;
  insert(item: DatabaseItem): Promise<DatabaseItem>;
  update(id: string, changes: DatabaseChanges): Promise<DatabaseItem | null>;
  delete(id: string): Promise<void>;
  retireLegacyContent(): Promise<void>;
}
