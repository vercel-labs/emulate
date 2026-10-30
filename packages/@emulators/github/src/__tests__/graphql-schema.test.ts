import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { schema as githubSchema } from "@octokit/graphql-schema";
import {
  buildSchema,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isObjectType,
  isUnionType,
  type GraphQLArgument,
  type GraphQLNamedType,
} from "graphql";
import { typeDefs } from "../graphql/schema.js";

const ours = buildSchema(typeDefs);
const github = buildSchema(githubSchema.idl, { assumeValidSDL: true });

const EMULATOR_ONLY = new Map([
  ["Mutation", new Set(["replaceActorsForAssignable", "requestReviewsByLogin"])],
  ["PullRequest", new Set(["assignedActors"])],
  ["SearchType", new Set(["ISSUE_ADVANCED"])],
  ["Issue", new Set(["assignedActors"])],
  ["AssigneeConnection", null],
  ["AssigneeEdge", null],
  ["ReplaceActorsForAssignableInput", null],
  ["ReplaceActorsForAssignablePayload", null],
  ["RequestReviewsByLoginInput", null],
  ["RequestReviewsByLoginPayload", null],
]);

function userTypes(): GraphQLNamedType[] {
  return Object.values(ours.getTypeMap()).filter((t) => !t.name.startsWith("__"));
}

function argSignature(args: readonly GraphQLArgument[]) {
  return Object.fromEntries(args.map((a) => [a.name, String(a.type)]));
}

describe("GitHub GraphQL schema conformance", () => {
  it("is a compatible subset of GitHub's public schema", () => {
    const problems: string[] = [];
    for (const type of userTypes()) {
      const exempt = EMULATOR_ONLY.get(type.name);
      if (exempt === null) continue;
      const real = github.getType(type.name);
      if (!real) {
        problems.push(`${type.name} does not exist on GitHub`);
        continue;
      }
      if (real.constructor !== type.constructor) {
        problems.push(`${type.name} has a different kind`);
        continue;
      }
      if (isObjectType(type) || isInterfaceType(type)) {
        const realFields = (real as typeof type).getFields();
        for (const field of Object.values(type.getFields())) {
          if (exempt?.has(field.name)) continue;
          const realField = realFields[field.name];
          if (!realField) {
            problems.push(`${type.name}.${field.name} does not exist on GitHub`);
            continue;
          }
          if (String(field.type) !== String(realField.type)) {
            problems.push(`${type.name}.${field.name}: ${field.type} != ${realField.type}`);
          }
          expect(argSignature(field.args), `${type.name}.${field.name} args`).toEqual(argSignature(realField.args));
        }
        const realInterfaces = new Set((real as typeof type).getInterfaces().map((i) => i.name));
        for (const iface of type.getInterfaces()) {
          if (!realInterfaces.has(iface.name)) problems.push(`${type.name} does not implement ${iface.name} on GitHub`);
        }
      } else if (isInputObjectType(type)) {
        const realFields = (real as typeof type).getFields();
        expect(
          Object.fromEntries(Object.values(type.getFields()).map((f) => [f.name, String(f.type)])),
          `${type.name} input fields`,
        ).toEqual(Object.fromEntries(Object.values(realFields).map((f) => [f.name, String(f.type)])));
      } else if (isEnumType(type)) {
        expect(
          type
            .getValues()
            .map((v) => v.name)
            .filter((name) => !exempt?.has(name)),
          `${type.name} values`,
        ).toEqual((real as typeof type).getValues().map((v) => v.name));
      } else if (isUnionType(type)) {
        const realMembers = new Set((real as typeof type).getTypes().map((t) => t.name));
        for (const member of type.getTypes()) {
          if (!realMembers.has(member.name)) problems.push(`${member.name} is not a member of ${type.name} on GitHub`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("covers the operations gh pr commands send", () => {
    const query = ours.getQueryType()!.getFields();
    const mutation = ours.getMutationType()!.getFields();
    expect(Object.keys(query)).toEqual(expect.arrayContaining(["viewer", "repository", "node", "search", "rateLimit"]));
    expect(Object.keys(mutation)).toEqual(
      expect.arrayContaining([
        "createPullRequest",
        "updatePullRequest",
        "closePullRequest",
        "reopenPullRequest",
        "mergePullRequest",
        "markPullRequestReadyForReview",
        "convertPullRequestToDraft",
        "addPullRequestReview",
        "submitPullRequestReview",
        "addComment",
      ]),
    );
  });

  it("is up to date with the generator", () => {
    const script = fileURLToPath(new URL("../../scripts/generate-graphql-schema.mjs", import.meta.url));
    expect(() => execFileSync(process.execPath, [script, "--check"], { stdio: "pipe" })).not.toThrow();
  });
});
