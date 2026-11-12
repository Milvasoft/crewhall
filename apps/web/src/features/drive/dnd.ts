import { type DriveNode } from '@crewhall/shared';
import { type DragEvent } from 'react';

/**
 * Drag to move inside Drive (3.12). The dataTransfer payload cannot be read during dragover, so
 * the dragged nodes live here for the length of one drag; the custom type only marks the drag
 * as ours (a desktop file drag carries "Files" instead).
 */
export const NODE_DRAG_TYPE = 'application/x-crewhall-nodes';

let dragged: DriveNode[] = [];

export function startNodeDrag(e: DragEvent, nodes: DriveNode[]): void {
  dragged = nodes;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData(NODE_DRAG_TYPE, nodes.map((n) => n.id).join(','));
  e.dataTransfer.setData('text/plain', nodes.map((n) => n.name).join('\n'));
}

export function endNodeDrag(): void {
  dragged = [];
}

export function draggedNodes(): DriveNode[] {
  return dragged;
}

export function isNodeDrag(e: DragEvent): boolean {
  return e.dataTransfer.types.includes(NODE_DRAG_TYPE);
}

export function isFileDrag(e: DragEvent): boolean {
  return e.dataTransfer.types.includes('Files');
}

/** A folder (or the space root, `id` null) that nodes may be dropped into. */
export interface DropFolder {
  spaceId: string;
  id: string | null;
  /** The folder and its parents, so a folder cannot go into itself or below itself. */
  ancestorIds?: readonly string[];
}

/** False for a no-op (already there) or a cycle (a folder into itself or its own subfolder). */
export function canMoveInto(nodes: readonly DriveNode[], target: DropFolder): boolean {
  if (nodes.length === 0) return false;
  const ids = new Set(nodes.map((n) => n.id));
  if (target.id !== null && ids.has(target.id)) return false;
  if (target.ancestorIds?.some((a) => ids.has(a))) return false;
  return !nodes.every((n) => n.spaceId === target.spaceId && n.parentId === target.id);
}
