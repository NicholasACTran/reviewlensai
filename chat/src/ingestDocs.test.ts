import { buildKbDocs } from "./ingestDocs";

const reviews = [
  { recommendationid: "1", language: "english", review: "great game", votes_up: 5, voted_up: true, timestamp_created: 100 },
  { recommendationid: "2", language: "russian", review: "круто", votes_up: 2, voted_up: true, timestamp_created: 101 },
  { recommendationid: "3", language: "english", review: "buggy", votes_up: 1, voted_up: false, timestamp_created: 102 },
];

test("keeps only english reviews, one doc each, with jobId metadata", () => {
  const docs = buildKbDocs("job-abc", reviews as any);
  expect(docs).toHaveLength(2);
  expect(docs.every((d) => d.metadata.jobId === "job-abc")).toBe(true);
  expect(docs.map((d) => d.id)).toEqual(["job-abc#1", "job-abc#3"]);
  expect(docs[0].text).toContain("great game");
});

test("empty when no english reviews", () => {
  expect(buildKbDocs("j", [reviews[1]] as any)).toEqual([]);
});
