import { z } from "zod";
import type { WikiStamp } from "../wiki/model.js";

const text = (max = 2048) => z.string().trim().min(1).max(max).refine(value => !value.includes("\0"), "Must not contain NUL characters");
const refs = z.array(text(256)).max(64).refine(ids => new Set(ids).size === ids.length, "References must be unique");
const capabilityId = z.string().regex(/^C-[a-z0-9][a-z0-9_-]{0,63}$/);
const unknownConditions = new Set(["", "unknown", "unspecified", "notrecorded", "未知", "未记录", "未确认"]);
/** Normalize placeholders only; real identities, paths and versions remain case-sensitive.
 * Reads use this too, so historical records need no destructive migration. */
export function knownCondition(value: string | null): string | null {
  return value === null || unknownConditions.has(value.normalize("NFKC").toLowerCase().replace(/[\s_-]+/g, "")) ? null : value;
}
const condition = z.string().trim().max(512).refine(value => !value.includes("\0"), "Must not contain NUL characters").nullable().transform(knownCondition);
export const conditionsSchema = z.object({ scope: condition, identity: condition, environment: condition, stateVersion: condition }).strict();
export const portSchema = z.object({ type: text(128), aliases: z.array(text(128)).max(8).default([]), description: text(1024) }).strict();
export const capabilityProposalSchema = z.object({ id: capabilityId, title: text(512), status: z.enum(["candidate", "available", "unavailable"]),
  provides: z.array(portSchema).min(1).max(8), needs: z.array(portSchema).max(8), conditions: conditionsSchema,
  factRefs: refs.refine(ids => ids.length > 0, "Capabilities require evidence-backed facts"), counterFactRefs: refs.default([]), changeReason: text(),
}).strict();
export const chainProposalSchema = z.object({ id: z.string().regex(/^CH-[a-z0-9][a-z0-9_-]{0,63}$/), title: text(512), status: z.enum(["candidate", "verified", "refuted"]),
  capabilityIds: z.array(capabilityId).min(2).max(32).refine(ids => new Set(ids).size === ids.length, "Capability IDs must be unique"),
  links: z.array(z.object({ producerId: capabilityId, consumerId: capabilityId, provideIndex: z.number().int().min(0), needIndex: z.number().int().min(0),
    status: z.enum(["candidate", "verified", "refuted"]), factRefs: refs, conditions: conditionsSchema, note: text(),
  }).strict()).min(1).max(64), conditions: conditionsSchema, result: text(), resultFactRefs: refs, counterFactRefs: refs.default([]), changeReason: text(),
}).strict();
export const capabilitiesSchema = z.array(capabilityProposalSchema).max(32).refine(items => new Set(items.map(item => item.id)).size === items.length, "Capability IDs must be unique per batch");
export const chainsSchema = z.array(chainProposalSchema).max(16).refine(items => new Set(items.map(item => item.id)).size === items.length, "Chain IDs must be unique per batch");
export type Conditions = z.infer<typeof conditionsSchema>;
export type Port = z.infer<typeof portSchema>;
export type CapabilityProposal = z.infer<typeof capabilityProposalSchema>;
export type ChainProposal = z.infer<typeof chainProposalSchema>;
export interface CapabilityRevision extends Omit<CapabilityProposal, "factRefs" | "counterFactRefs"> {
  factIds: string[]; counterFactIds: string[]; revision: number; basis: WikiStamp[];
}
export interface Capability extends CapabilityRevision { history: CapabilityRevision[] }
export interface ChainRevision extends Omit<ChainProposal, "links" | "resultFactRefs" | "counterFactRefs"> {
  links: (Omit<ChainProposal["links"][number], "factRefs"> & { factIds: string[] })[];
  resultFactIds: string[]; counterFactIds: string[]; revision: number; basis: WikiStamp[];
}
export interface Chain extends ChainRevision { history: ChainRevision[] }

export const typeNames = (port: Port): string[] => [...new Set([port.type, ...port.aliases].map(value => value.normalize("NFKC").toLowerCase().trim()))];
export const portsMatch = (provide: Port, need: Port): boolean => typeNames(provide).some(type => typeNames(need).includes(type));
export function compareConditions(values: Conditions[]) {
  const conflicts: (keyof Conditions)[] = [], unknown: (keyof Conditions)[] = [];
  for (const key of ["scope", "identity", "environment", "stateVersion"] as const) {
    const known = values.map(value => knownCondition(value[key]));
    if (known.includes(null)) unknown.push(key);
    if (new Set(known.filter(value => value !== null)).size > 1) conflicts.push(key);
  }
  return { status: conflicts.length ? "conflict" as const : unknown.length ? "unknown" as const : "compatible" as const, conflicts, unknown };
}
