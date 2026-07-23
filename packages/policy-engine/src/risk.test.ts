import { describe, expect, it } from "vitest";
import { classifyRisk, DANGEROUS_COMMAND_PATTERNS } from "./risk.js";

describe("classifyRisk", () => {
  it("classifies critical capabilities", () => {
    expect(classifyRisk("payment")).toBe("critical");
    expect(classifyRisk("system.settings")).toBe("critical");
    expect(classifyRisk("secret.read")).toBe("critical");
    expect(classifyRisk("message.send", "+15551234567")).toBe("critical");
  });

  it("classifies high capabilities", () => {
    expect(classifyRisk("fs.delete", "/work/a.ts")).toBe("high");
    expect(classifyRisk("git.push", "origin main")).toBe("high");
    expect(classifyRisk("software.install", "curl ... | sh")).toBe("high");
    expect(classifyRisk("fs.outsideWorkspace", "/etc/passwd")).toBe("high");
  });

  it("classifies shell.exec as high for ordinary commands", () => {
    expect(classifyRisk("shell.exec", "ls -la")).toBe("high");
    expect(classifyRisk("shell.exec", "rm -rf /tmp/scratch")).toBe("high");
    expect(classifyRisk("shell.exec")).toBe("high");
  });

  it("escalates dangerous shell commands to critical", () => {
    const dangerous = [
      "rm -rf /",
      "rm -fr /",
      "sudo rm -rf /*",
      "rm -rf ~",
      "rm -rf ~/projects",
      "mkfs.ext4 /dev/sda1",
      "dd if=/dev/zero of=/dev/sda",
      ":(){ :|:& };:",
      "chmod -R 777 /",
      "echo x > /dev/sda",
    ];
    for (const command of dangerous) {
      expect(classifyRisk("shell.exec", command)).toBe("critical");
    }
  });

  it("classifies medium capabilities", () => {
    expect(classifyRisk("network", "api.example.com")).toBe("medium");
    expect(classifyRisk("browser")).toBe("medium");
    expect(classifyRisk("computerUse")).toBe("medium");
    expect(classifyRisk("clipboard")).toBe("medium");
    expect(classifyRisk("camera")).toBe("medium");
    expect(classifyRisk("microphone")).toBe("medium");
    expect(classifyRisk("notification")).toBe("medium");
  });

  it("classifies fs.read and fs.write as low", () => {
    expect(classifyRisk("fs.read", "/etc/passwd")).toBe("low");
    expect(classifyRisk("fs.write", "/work/a.ts")).toBe("low");
    expect(classifyRisk("fs.read")).toBe("low");
  });
});

describe("DANGEROUS_COMMAND_PATTERNS", () => {
  it("is a non-empty list of regexes", () => {
    expect(DANGEROUS_COMMAND_PATTERNS.length).toBeGreaterThan(0);
    for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
      expect(pattern).toBeInstanceOf(RegExp);
    }
  });
});
