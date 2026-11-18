import test from "node:test";
import assert from "node:assert/strict";

import {
  PLATFORM_SKILLS,
  OFFICE_SKILLS,
  MAIL_SKILL_IDS,
  INSTALLABLE_SKILL_IDS,
  DEFAULT_INSTALLED_SKILLS,
  isPlatformSkill,
  isBuiltinPlatformSkill,
  isInstallableSkill,
  resolveInstalledSkillIds,
  inferMailServerPreset,
} from "../src/shared/skills-catalog.js";

test("resolveInstalledSkillIds defaults to both mail skills when unset (kimi-cu requires manual add)", () => {
  assert.deepEqual(resolveInstalledSkillIds(undefined), ["qqmail", "custom-mail"]);
  assert.deepEqual(resolveInstalledSkillIds({}), ["qqmail", "custom-mail"]);
  assert.deepEqual(DEFAULT_INSTALLED_SKILLS, ["qqmail", "custom-mail"]);
});

test("resolveInstalledSkillIds respects explicit lists including optional kimi-cu, dedupes and drops builtin/invalid ids", () => {
  assert.deepEqual(resolveInstalledSkillIds({ installedSkills: [] }), []);
  assert.deepEqual(
    resolveInstalledSkillIds({
      installedSkills: ["qqmail", "qqmail", "kimi-cu", "bogus", "desktop-control"],
    }),
    ["qqmail", "kimi-cu"]
  );
});

test("catalog exposes 7 built-in platform skills + 1 optional kimi-cu platform skill and 2 office skills", () => {
  assert.equal(PLATFORM_SKILLS.length, 8);
  assert.deepEqual(
    PLATFORM_SKILLS.map((s) => s.id),
    [
      "desktop-control",
      "shell-and-files",
      "ai-image",
      "multi-bot-collab",
      "interactive-cards",
      "custom-skill-manager",
      "websearch",
      "kimi-cu",
    ]
  );
  assert.equal(isBuiltinPlatformSkill("custom-skill-manager"), true);
  assert.equal(isInstallableSkill("custom-skill-manager"), false);
  assert.deepEqual(OFFICE_SKILLS.map((s) => s.id), MAIL_SKILL_IDS);
  assert.deepEqual(INSTALLABLE_SKILL_IDS, ["qqmail", "custom-mail", "kimi-cu"]);
  assert.equal(isPlatformSkill("ai-image"), true);
  assert.equal(isBuiltinPlatformSkill("ai-image"), true);
  assert.equal(isInstallableSkill("ai-image"), false);
  assert.equal(isPlatformSkill("kimi-cu"), true);
  assert.equal(isBuiltinPlatformSkill("kimi-cu"), false);
  assert.equal(isInstallableSkill("kimi-cu"), true);
  assert.equal(isInstallableSkill("qqmail"), true);
  assert.equal(isInstallableSkill("bogus"), false);
});

test("inferMailServerPreset knows 163 IMAP and POP3", () => {
  assert.deepEqual(inferMailServerPreset("a@163.com"), {
    inboundProtocol: "imap",
    inboundHost: "imap.163.com",
    inboundPort: 993,
    inboundTls: true,
    smtpHost: "smtp.163.com",
    smtpPort: 465,
    smtpSecurity: "ssl",
  });
  const pop: any = inferMailServerPreset("a@163.com", "pop3");
  assert.equal(pop.inboundHost, "pop.163.com");
  assert.equal(pop.inboundPort, 995);
});

test("inferMailServerPreset uses STARTTLS 587 for outlook", () => {
  const p: any = inferMailServerPreset("Me@Outlook.com");
  assert.equal(p.inboundHost, "outlook.office365.com");
  assert.equal(p.inboundPort, 993);
  assert.equal(p.smtpHost, "smtp.office365.com");
  assert.equal(p.smtpPort, 587);
  assert.equal(p.smtpSecurity, "starttls");
});

test("inferMailServerPreset unknown domain fallback", () => {
  const p: any = inferMailServerPreset("x@acme.cn");
  assert.equal(p.inboundHost, "imap.acme.cn");
  assert.equal(p.inboundPort, 993);
  assert.equal(p.smtpHost, "smtp.acme.cn");
  assert.equal(p.smtpPort, 465);
  const pop: any = inferMailServerPreset("x@acme.cn", "pop3");
  assert.equal(pop.inboundHost, "pop.acme.cn");
  assert.equal(pop.inboundPort, 995);
});

test("inferMailServerPreset returns null for invalid email", () => {
  assert.equal(inferMailServerPreset(""), null);
  assert.equal(inferMailServerPreset("not-an-email"), null);
  assert.equal(inferMailServerPreset("a@nodot"), null);
});
