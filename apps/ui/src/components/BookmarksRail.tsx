import { useState, type CSSProperties } from "react";
import type { PdfOutlineItem, PdfOutlineState, PdfOutlineTarget } from "@raiopdf/engine-api";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronRightIcon,
  DeleteIcon,
  EditIcon,
  PlusIcon,
} from "../icons";
import { IconButton } from "./IconButton";
import { Switch } from "./Switch";
import "./BookmarksRail.css";

export interface BookmarksRailProps {
  outline: PdfOutlineState | null;
  outlineStatus: string | null;
  pageCount: number;
  currentPage: number;
  disabled?: boolean | undefined;
  onNavigate: (pageIndex: number) => void;
  onChange: (outline: PdfOutlineState) => Promise<boolean>;
}

type BookmarkPath = readonly number[];

export function BookmarksRail({
  outline,
  outlineStatus,
  pageCount,
  currentPage,
  disabled = false,
  onNavigate,
  onChange,
}: BookmarksRailProps) {
  const [busy, setBusy] = useState(false);
  const canEdit = Boolean(outline) && pageCount > 0 && !disabled && !busy;

  async function commit(next: PdfOutlineState) {
    if (!canEdit) {
      return;
    }

    setBusy(true);
    try {
      await onChange(next);
    } finally {
      setBusy(false);
    }
  }

  function commitItems(items: readonly PdfOutlineItem[]) {
    if (!outline) {
      return;
    }

    void commit({
      ...outline,
      items,
      revision: nextOutlineRevision(),
    });
  }

  function addRootBookmark() {
    if (!outline) {
      return;
    }

    commitItems([
      ...outline.items,
      createPageBookmark(currentPage, "Bookmark"),
    ]);
  }

  function toggleOpenMode(next: boolean) {
    if (!outline) {
      return;
    }

    void commit({
      ...outline,
      openMode: next ? "outlines" : "default",
      revision: nextOutlineRevision(),
    });
  }

  if (!outline) {
    return (
      <section className="bookmarks-rail" aria-label="Bookmarks">
        <p className="bookmarks-rail__empty">Bookmarks are unavailable for this document.</p>
      </section>
    );
  }

  return (
    <section className="bookmarks-rail" aria-label="Bookmarks" aria-busy={busy ? "true" : undefined}>
      <div className="bookmarks-rail__toolbar">
        <IconButton
          icon={<PlusIcon size={14} />}
          label="Add bookmark"
          onClick={addRootBookmark}
          disabled={!canEdit}
        />
        <div className="bookmarks-rail__open-mode">
          <Switch
            checked={outline.openMode === "outlines"}
            onChange={toggleOpenMode}
            disabled={!canEdit}
            label="Open bookmarks by default"
          />
          <span>Open</span>
        </div>
      </div>

      {outlineStatus ? <p className="bookmarks-rail__status">{outlineStatus}</p> : null}

      {outline.items.length === 0 ? (
        <p className="bookmarks-rail__empty">No bookmarks</p>
      ) : (
        <ol className="bookmarks-rail__tree">
          {outline.items.map((item, index) => (
            <BookmarkNode
              key={item.id}
              item={item}
              path={[index]}
              depth={0}
              outline={outline}
              canEdit={canEdit}
              currentPage={currentPage}
              onNavigate={onNavigate}
              onCommitItems={commitItems}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

function BookmarkNode({
  item,
  path,
  depth,
  outline,
  canEdit,
  currentPage,
  onNavigate,
  onCommitItems,
}: {
  item: PdfOutlineItem;
  path: BookmarkPath;
  depth: number;
  outline: PdfOutlineState;
  canEdit: boolean;
  currentPage: number;
  onNavigate: (pageIndex: number) => void;
  onCommitItems: (items: readonly PdfOutlineItem[]) => void;
}) {
  const [expanded, setExpanded] = useState(item.expanded !== false);
  const children = item.children ?? [];
  const pageTarget = item.target.kind === "page";
  const navigablePage = pageIndexForTarget(item.target);
  const editableBookmark = canEdit;
  const parentPath = path.slice(0, -1);
  const index = path[path.length - 1] ?? 0;
  const siblings = itemsAtPath(outline.items, parentPath);
  const canMoveUp = editableBookmark && index > 0;
  const canMoveDown = editableBookmark && index < siblings.length - 1;
  const canIndent = editableBookmark && index > 0;
  const canOutdent = editableBookmark && path.length > 1;

  function rename() {
    const nextTitle = window.prompt("Bookmark title", item.title)?.trim();
    if (!nextTitle || nextTitle === item.title) {
      return;
    }

    onCommitItems(updateItemAtPath(outline.items, path, (current) => ({
      ...current,
      title: nextTitle,
    })));
  }

  function addChild() {
    if (!editableBookmark) {
      return;
    }

    onCommitItems(updateItemAtPath(outline.items, path, (current) => withChildren(current, [
      ...(current.children ?? []),
      createPageBookmark(currentPage, "Bookmark"),
    ])));
    setExpanded(true);
  }

  function retarget() {
    if (!editableBookmark) {
      return;
    }

    onCommitItems(updateItemAtPath(outline.items, path, (current) => ({
      ...current,
      target: { kind: "page", pageIndex: currentPage - 1 },
    })));
  }

  function remove() {
    if (!editableBookmark) {
      return;
    }

    onCommitItems(removeItemAtPath(outline.items, path).items);
  }

  function move(delta: -1 | 1) {
    if (!editableBookmark) {
      return;
    }

    onCommitItems(updateItemsAtPath(outline.items, parentPath, (currentSiblings) => {
      const next = [...currentSiblings];
      const targetIndex = index + delta;
      const [removed] = next.splice(index, 1);
      if (!removed) {
        return currentSiblings;
      }
      next.splice(targetIndex, 0, removed);
      return next;
    }));
  }

  function indent() {
    if (!canIndent) {
      return;
    }

    const removed = removeItemAtPath(outline.items, path);
    const previousSiblingPath = [...parentPath, index - 1];
    onCommitItems(updateItemAtPath(removed.items, previousSiblingPath, (previous) =>
      withChildren(previous, [...(previous.children ?? []), removed.item])));
  }

  function outdent() {
    if (!canOutdent) {
      return;
    }

    const removed = removeItemAtPath(outline.items, path);
    const grandparentPath = path.slice(0, -2);
    const parentIndex = parentPath[parentPath.length - 1] ?? 0;
    onCommitItems(updateItemsAtPath(removed.items, grandparentPath, (currentSiblings) => [
      ...currentSiblings.slice(0, parentIndex + 1),
      removed.item,
      ...currentSiblings.slice(parentIndex + 1),
    ]));
  }

  return (
    <li className="bookmarks-rail__node">
      <div
        className="bookmarks-rail__row"
        style={{ "--bookmark-depth": depth } as CSSProperties}
        data-view-only={pageTarget ? undefined : "true"}
      >
        <button
          type="button"
          className="bookmarks-rail__twisty"
          aria-label={expanded ? "Collapse bookmark" : "Expand bookmark"}
          aria-expanded={children.length > 0 ? expanded : undefined}
          disabled={children.length === 0}
          onClick={() => setExpanded((current) => !current)}
        >
          <ChevronRightIcon size={12} />
        </button>

        <button
          type="button"
          className="bookmarks-rail__title"
          title={targetLabel(item.target)}
          disabled={navigablePage === null}
          onClick={() => {
            if (navigablePage !== null) {
              onNavigate(navigablePage);
            }
          }}
        >
          <span className="bookmarks-rail__title-text">{item.title}</span>
          <span className="bookmarks-rail__target">{targetLabel(item.target)}</span>
        </button>

        <div className="bookmarks-rail__actions">
          <IconButton icon={<EditIcon size={13} />} label="Rename bookmark" onClick={rename} disabled={!editableBookmark} />
          <IconButton icon={<PlusIcon size={13} />} label="Add child bookmark" onClick={addChild} disabled={!editableBookmark} />
          <button
            type="button"
            className="bookmarks-rail__page-button"
            title={`Set bookmark to page ${currentPage}`}
            disabled={!editableBookmark}
            onClick={retarget}
          >
            {currentPage}
          </button>
          <IconButton icon={<ArrowUpIcon size={13} />} label="Move bookmark up" onClick={() => move(-1)} disabled={!canMoveUp} />
          <IconButton icon={<ArrowDownIcon size={13} />} label="Move bookmark down" onClick={() => move(1)} disabled={!canMoveDown} />
          <button
            type="button"
            className="bookmarks-rail__nest-button"
            title="Nest bookmark"
            disabled={!canIndent}
            onClick={indent}
          >
            &gt;
          </button>
          <button
            type="button"
            className="bookmarks-rail__nest-button"
            title="Unnest bookmark"
            disabled={!canOutdent}
            onClick={outdent}
          >
            &lt;
          </button>
          <IconButton icon={<DeleteIcon size={13} />} label="Delete bookmark" onClick={remove} disabled={!editableBookmark} />
        </div>
      </div>

      {children.length > 0 && expanded ? (
        <ol className="bookmarks-rail__children">
          {children.map((child, childIndex) => (
            <BookmarkNode
              key={child.id}
              item={child}
              path={[...path, childIndex]}
              depth={depth + 1}
              outline={outline}
              canEdit={canEdit}
              currentPage={currentPage}
              onNavigate={onNavigate}
              onCommitItems={onCommitItems}
            />
          ))}
        </ol>
      ) : null}
    </li>
  );
}

function createPageBookmark(currentPage: number, title: string): PdfOutlineItem {
  return {
    id: `bookmark:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    title: `${title} ${currentPage}`,
    target: { kind: "page", pageIndex: currentPage - 1 },
    expanded: true,
  };
}

function pageIndexForTarget(target: PdfOutlineTarget): number | null {
  if (target.kind === "page") {
    return target.pageIndex;
  }

  if (target.kind === "named" && target.resolvedPageIndex !== undefined) {
    return target.resolvedPageIndex;
  }

  return null;
}

function targetLabel(target: PdfOutlineTarget): string {
  switch (target.kind) {
    case "page":
      return `Page ${target.pageIndex + 1}`;
    case "named":
      return target.resolvedPageIndex === undefined
        ? `Named: ${target.name}`
        : `Named: ${target.name} -> page ${target.resolvedPageIndex + 1}`;
    case "uri":
      return "Web link";
    case "remote":
      return "Remote file";
    case "unsupported":
      return "View-only";
  }
}

function itemAtPath(items: readonly PdfOutlineItem[], path: BookmarkPath): PdfOutlineItem | null {
  let currentItems = items;
  let current: PdfOutlineItem | undefined;

  for (const index of path) {
    current = currentItems[index];
    if (!current) {
      return null;
    }
    currentItems = current.children ?? [];
  }

  return current ?? null;
}

function itemsAtPath(items: readonly PdfOutlineItem[], path: BookmarkPath): readonly PdfOutlineItem[] {
  if (path.length === 0) {
    return items;
  }

  return itemAtPath(items, path)?.children ?? [];
}

function updateItemAtPath(
  items: readonly PdfOutlineItem[],
  path: BookmarkPath,
  update: (item: PdfOutlineItem) => PdfOutlineItem,
): readonly PdfOutlineItem[] {
  const [head, ...tail] = path;
  if (head === undefined) {
    return items;
  }

  return items.map((item, index) => {
    if (index !== head) {
      return item;
    }

    if (tail.length === 0) {
      return update(item);
    }

    return withChildren(item, updateItemAtPath(item.children ?? [], tail, update));
  });
}

function updateItemsAtPath(
  items: readonly PdfOutlineItem[],
  path: BookmarkPath,
  update: (items: readonly PdfOutlineItem[]) => readonly PdfOutlineItem[],
): readonly PdfOutlineItem[] {
  if (path.length === 0) {
    return update(items);
  }

  return updateItemAtPath(items, path, (item) => withChildren(item, update(item.children ?? [])));
}

function removeItemAtPath(
  items: readonly PdfOutlineItem[],
  path: BookmarkPath,
): { items: readonly PdfOutlineItem[]; item: PdfOutlineItem } {
  const parentPath = path.slice(0, -1);
  const index = path[path.length - 1];
  const siblings = itemsAtPath(items, parentPath);
  const item = index === undefined ? undefined : siblings[index];

  if (!item || index === undefined) {
    throw new Error("Bookmark no longer exists.");
  }

  return {
    item,
    items: updateItemsAtPath(items, parentPath, (currentSiblings) =>
      currentSiblings.filter((_, siblingIndex) => siblingIndex !== index)),
  };
}

function withChildren(
  item: PdfOutlineItem,
  children: readonly PdfOutlineItem[],
): PdfOutlineItem {
  const { children: _children, ...withoutChildren } = item;

  return children.length > 0
    ? { ...withoutChildren, children }
    : withoutChildren;
}

function nextOutlineRevision(): string {
  return `ui:${Date.now()}`;
}
