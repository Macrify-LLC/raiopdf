export type AuthorityKind = "case" | "statute" | "rule" | "constitutional" | "other";

export type AuthorityHit = {
  pageIndex: number;
};

export type DetectedAuthority = {
  id: string;
  kind: AuthorityKind;
  canonical: string;
  hits: AuthorityHit[];
};
