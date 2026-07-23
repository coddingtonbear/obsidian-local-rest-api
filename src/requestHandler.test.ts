import http from "http";
import request from "supertest";

// Mock McpHandler so tests don't load the MCP SDK (which bundles ESM-only zod)
jest.mock("./mcpHandler", () => ({
  McpHandler: jest.fn().mockImplementation(() => ({
    handleRequest: jest.fn().mockImplementation((_req: unknown, res: { status: (c: number) => { json: (b: unknown) => void } }) => {
      res.status(200).json({ ok: true });
    }),
    registerTool: jest.fn().mockReturnValue(jest.fn()),
  })),
}));

import RequestHandler from "./requestHandler";
import { LocalRestApiSettings } from "./types";
import { CERT_NAME } from "./constants";
import {
  DestinationAlreadyExistsError,
  FileNotFoundError,
} from "./vaultOperations";
import { FrontmatterParseError } from "markdown-patch";
import {
  App,
  TFile,
  Command,
  CachedMetadata,
  PluginManifest,
  _prepareSimpleSearchMock,
} from "../mocks/obsidian";
import * as dailyNotesInterface from "obsidian-daily-notes-interface";

describe("requestHandler", () => {
  const API_KEY = "my api key";

  let settings: LocalRestApiSettings;
  let app: App;
  let manifest: PluginManifest;
  let handler: RequestHandler;
  let server: http.Server;

  beforeEach(() => {
    settings = getMockSettings();
    // This 'App' instance is actually a mock, and it doesn't define
    // quite a perfectly-matching interface for the actual Obsidian
    // App interface.
    app = new App();
    manifest = new PluginManifest();
    // @ts-ignore: Ignore missing App properties
    handler = new RequestHandler(app, manifest, settings);
    handler.setupRouter();
    server = http.createServer(handler.api);
  });

  afterEach(() => {
    server.close();
  });

  function getMockSettings(): LocalRestApiSettings {
    return {
      apiKey: API_KEY,
      crypto: {
        cert: "cert",
        privateKey: "privateKey",
        publicKey: "publicKey",
      },
      port: 1,
      insecurePort: 2,
      enableInsecureServer: false,
    };
  }
  describe("requestIsAuthenticated", () => {
    const arbitraryAuthenticatedRoute = "/vault/";

    test("missing header", async () => {
      await request(server).get(arbitraryAuthenticatedRoute).expect(401);
    });
    test("incorrect header", async () => {
      await request(server)
        .get(arbitraryAuthenticatedRoute)
        .set("Authorization", "Bearer of good tidings")
        .expect(401);
    });
    test("correct header", async () => {
      await request(server)
        .get(arbitraryAuthenticatedRoute)
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(200);
    });
  });

  describe("root", () => {
    test("withhout auth", async () => {
      const result = await request(server).get("/").expect(200);

      expect(result.body.status).toEqual("OK");
      expect(result.body.authenticated).toBeFalsy();
    });

    test("with auth", async () => {
      const result = await request(server)
        .get("/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(200);

      expect(result.body.status).toEqual("OK");
      expect(result.body.authenticated).toBeTruthy();
    });
  });

  describe("certificateGet", () => {
    const certPath = `/${CERT_NAME}`;

    test("withhout auth", async () => {
      const result = await request(server).get(certPath).expect(200);

      expect(result.body.toString()).toEqual(settings.crypto?.cert);
    });

    test("with auth", async () => {
      const result = await request(server)
        .get(certPath)
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(200);

      expect(result.body.toString()).toEqual(settings.crypto.cert);
    });
  });

  describe("vaultGet", () => {
    test("directory empty", async () => {
      app.vault._files = [];

      const result = await request(server)
        .get("/vault/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(200);

      expect(result.body.files).toEqual([]);
    });

    test("empty subdirectory returns 404", async () => {
      app.vault._files = [];
      app.vault.adapter._exists = false;

      await request(server)
        .get("/vault/nonexistent/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(404);
    });

    test("directory with files", async () => {
      const arbitraryDirectory = "somewhere";

      const rootFile = new TFile();
      rootFile.path = "rootFile.md";

      const notRootFile = new TFile();
      notRootFile.path = `${arbitraryDirectory}/anotherFile.md`;

      app.vault._files = [rootFile, notRootFile];

      const result = await request(server)
        .get("/vault/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(200);

      expect(result.body.files).toEqual([
        rootFile.path,
        `${arbitraryDirectory}/`,
      ]);
    });

    test("unauthorized", async () => {
      const arbitraryFilename = "somefile.md";
      const arbitraryFileContent = "Beep boop";

      app.vault.adapter._read = arbitraryFileContent;

      await request(server).get(`/vault/${arbitraryFilename}`).expect(401);
    });

    test("file content", async () => {
      const arbitraryFilename = "somefile.md";
      const arbitraryFileContent = "Beep boop";
      const fileContentBuffer = new ArrayBuffer(arbitraryFileContent.length);
      const fileContentBufferView = new Uint8Array(fileContentBuffer);
      for (let i = 0; i < arbitraryFileContent.length; i++) {
        fileContentBufferView[i] = arbitraryFileContent.charCodeAt(i);
      }

      app.vault.adapter._readBinary = fileContentBuffer;

      const result = await request(server)
        .get(`/vault/${arbitraryFilename}`)
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(200);

      expect(result.header["content-disposition"]).toEqual(
        `attachment; filename="${arbitraryFilename}"`
      );
      expect(result.header["content-type"]).toEqual(
        "text/markdown; charset=utf-8"
      );
      expect(result.text).toEqual(arbitraryFileContent);
    });

    test("file does not exist", async () => {
      const arbitraryFilename = "somefile.md";

      app.vault.adapter._exists = false;

      await request(server)
        .get(`/vault/${arbitraryFilename}`)
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(404);
    });

    test("Accept: text/html returns rendered HTML", async () => {
      const arbitraryFilename = "somefile.md";
      const renderedHtml = "<h1>Rendered</h1>";
      jest.spyOn(handler.operations, "renderFileToHtml").mockResolvedValue(renderedHtml);

      const result = await request(server)
        .get(`/vault/${arbitraryFilename}`)
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Accept", "text/html")
        .expect(200);

      expect(result.header["content-type"]).toEqual("text/html; charset=utf-8");
      expect(result.text).toEqual(renderedHtml);
      expect(handler.operations.renderFileToHtml).toHaveBeenCalledWith(
        app.vault._getAbstractFileByPath,
      );
    });

    test("Accept: text/html on non-existent file returns 404", async () => {
      const arbitraryFilename = "somefile.md";
      app.vault._getAbstractFileByPath = null;

      await request(server)
        .get(`/vault/${arbitraryFilename}`)
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Accept", "text/html")
        .expect(404);
    });

    test("Accept: application/vnd.olrapi.note+json includes links, backlinks, and unresolvedLinks", async () => {
      const targetPath = app.vault._getAbstractFileByPath.path;

      app.metadataCache.resolvedLinks = {
        [targetPath]: { "resolved-target.md": 1 },
        "other.md": { [targetPath]: 1 },
      };
      app.metadataCache.unresolvedLinks = {
        [targetPath]: { "not-yet-created.md": 1 },
      };

      const result = await request(server)
        .get(`/vault/${targetPath}`)
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Accept", "application/vnd.olrapi.note+json")
        .expect(200);

      expect(result.body.links).toEqual(["resolved-target.md"]);
      expect(result.body.backlinks).toEqual(["other.md"]);
      expect(result.body.unresolvedLinks).toEqual(["not-yet-created.md"]);

    });
  });

  describe("vaultGet section retrieval", () => {
    const markdownWithHeadings = [
      "---",
      "title: Test Doc",
      "---",
      "# Heading1",
      "Content under heading1",
      "## SubHeading",
      "Sub content",
      "# Heading2",
      "Content under heading2",
      "",
    ].join("\n");

    const markdownWithBlock = [
      "# Heading1",
      "Some content",
      "Block content ^myblock",
      "# Heading2",
      "More content",
      "",
    ].join("\n");

    function setFileContent(content: string): void {
      app.vault.adapter._read = content;
      // readBinary is used by the default GET path
      const buf = new ArrayBuffer(content.length);
      const view = new Uint8Array(buf);
      for (let i = 0; i < content.length; i++) {
        view[i] = content.charCodeAt(i);
      }
      app.vault.adapter._readBinary = buf;
    }

    test("heading section returns only that heading's content", async () => {
      setFileContent(markdownWithHeadings);

      const result = await request(server)
        .get("/vault/somefile.md")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Accept", "text/markdown")
        .set("Target-Type", "heading")
        .set("Target", "Heading2")
        .expect(200);

      expect(result.text).toEqual("Content under heading2\n");
    });

    test("nested heading section via delimiter", async () => {
      setFileContent(markdownWithHeadings);

      const result = await request(server)
        .get("/vault/somefile.md")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Accept", "text/markdown")
        .set("Target-Type", "heading")
        .set("Target", "Heading1::SubHeading")
        .expect(200);

      expect(result.text).toEqual("Sub content\n");
    });

    test("nested heading with custom delimiter", async () => {
      setFileContent(markdownWithHeadings);

      const result = await request(server)
        .get("/vault/somefile.md")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Accept", "text/markdown")
        .set("Target-Type", "heading")
        .set("Target", "Heading1||SubHeading")
        .set("Target-Delimiter", "||")
        .expect(200);

      expect(result.text).toEqual("Sub content\n");
    });

    test("block reference returns block content", async () => {
      setFileContent(markdownWithBlock);

      const result = await request(server)
        .get("/vault/somefile.md")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Accept", "text/markdown")
        .set("Target-Type", "block")
        .set("Target", "myblock")
        .expect(200);

      expect(result.text).toEqual("Some content\nBlock content");
    });

    test("frontmatter field returns value as JSON", async () => {
      setFileContent(markdownWithHeadings);

      const result = await request(server)
        .get("/vault/somefile.md")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Target-Type", "frontmatter")
        .set("Target", "title")
        .expect(200);

      expect(result.body).toEqual("Test Doc");
    });

    test("non-existent heading returns 404", async () => {
      setFileContent(markdownWithHeadings);

      await request(server)
        .get("/vault/somefile.md")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Accept", "text/markdown")
        .set("Target-Type", "heading")
        .set("Target", "NoSuchHeading")
        .expect(404);
    });

    test("non-existent block returns 404", async () => {
      setFileContent(markdownWithBlock);

      await request(server)
        .get("/vault/somefile.md")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Accept", "text/markdown")
        .set("Target-Type", "block")
        .set("Target", "nonexistent")
        .expect(404);
    });

    test("non-existent frontmatter field returns 404", async () => {
      setFileContent(markdownWithHeadings);

      await request(server)
        .get("/vault/somefile.md")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Target-Type", "frontmatter")
        .set("Target", "nonexistent")
        .expect(404);
    });

    test("Target-Type without Target returns 400", async () => {
      setFileContent(markdownWithHeadings);

      await request(server)
        .get("/vault/somefile.md")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Accept", "text/markdown")
        .set("Target-Type", "heading")
        .expect(400);
    });

    test("invalid Target-Type returns 400", async () => {
      setFileContent(markdownWithHeadings);

      await request(server)
        .get("/vault/somefile.md")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Accept", "text/markdown")
        .set("Target-Type", "invalid")
        .set("Target", "something")
        .expect(400);
    });

    test("invalid Target-Type without Target still returns 400 for bad type", async () => {
      setFileContent(markdownWithHeadings);

      await request(server)
        .get("/vault/somefile.md")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Accept", "text/markdown")
        .set("Target-Type", "invalid")
        .expect(400);
    });

    test("non-existent file returns 404", async () => {
      app.vault.adapter._exists = false;

      await request(server)
        .get("/vault/somefile.md")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Accept", "text/markdown")
        .set("Target-Type", "heading")
        .set("Target", "Heading1")
        .expect(404);
    });

    test("directory path ignores section headers", async () => {
      const rootFile = new TFile();
      rootFile.path = "rootFile.md";
      app.vault._files = [rootFile];

      const result = await request(server)
        .get("/vault/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Target-Type", "heading")
        .set("Target", "Heading1")
        .expect(200);

      expect(result.body.files).toEqual(["rootFile.md"]);
    });

    test("heading section with parent includes nested content", async () => {
      setFileContent(markdownWithHeadings);

      const result = await request(server)
        .get("/vault/somefile.md")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Accept", "text/markdown")
        .set("Target-Type", "heading")
        .set("Target", "Heading1")
        .expect(200);

      // Heading1's content includes everything down to Heading2
      expect(result.text).toContain("Content under heading1");
      expect(result.text).toContain("Sub content");
      expect(result.text).not.toContain("Content under heading2");
    });

    test("Accept: text/html with heading target renders only that section", async () => {
      setFileContent(markdownWithHeadings);
      const renderedHtml = "<p>Sub content</p>";
      jest.spyOn(handler.operations, "renderFileToHtml").mockResolvedValue(renderedHtml);

      const result = await request(server)
        .get("/vault/somefile.md")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Accept", "text/html")
        .set("Target-Type", "heading")
        .set("Target", "Heading1::SubHeading")
        .expect(200);

      expect(result.header["content-type"]).toEqual("text/html; charset=utf-8");
      expect(result.text).toEqual(renderedHtml);
      expect(handler.operations.renderFileToHtml).toHaveBeenCalledWith(
        app.vault._getAbstractFileByPath,
        "Sub content\n",
      );
    });

    test("Accept: text/html with block target renders only that block", async () => {
      setFileContent(markdownWithBlock);
      const renderedHtml = "<p>Some content Block content</p>";
      jest.spyOn(handler.operations, "renderFileToHtml").mockResolvedValue(renderedHtml);

      const result = await request(server)
        .get("/vault/somefile.md")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Accept", "text/html")
        .set("Target-Type", "block")
        .set("Target", "myblock")
        .expect(200);

      expect(result.text).toEqual(renderedHtml);
      expect(handler.operations.renderFileToHtml).toHaveBeenCalledWith(
        app.vault._getAbstractFileByPath,
        "Some content\nBlock content",
      );
    });

    test("Accept: text/html with frontmatter target returns 400", async () => {
      setFileContent(markdownWithHeadings);

      await request(server)
        .get("/vault/somefile.md")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Accept", "text/html")
        .set("Target-Type", "frontmatter")
        .set("Target", "title")
        .expect(400);
    });

    test("Accept: text/html with non-existent heading target returns 404", async () => {
      setFileContent(markdownWithHeadings);

      await request(server)
        .get("/vault/somefile.md")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Accept", "text/html")
        .set("Target-Type", "heading")
        .set("Target", "NoSuchHeading")
        .expect(404);
    });
  });

  describe("vaultPut", () => {
    test("directory", async () => {
      await request(server)
        .put("/vault/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(405);
    });

    test("unauthorized", async () => {
      const arbitraryFilePath = "somefile.md";
      const arbitraryBytes = "bytes";

      await request(server)
        .put(`/vault/${arbitraryFilePath}`)
        .set("Content-Type", "text/markdown")
        .send(arbitraryBytes)
        .expect(401);
    });

    test("acceptable content", async () => {
      const arbitraryFilePath = "somefile.md";
      const arbitraryBytes = "bytes";

      await request(server)
        .put(`/vault/${arbitraryFilePath}`)
        .set("Content-Type", "text/markdown")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send(arbitraryBytes)
        .expect(204);

      expect(app.vault.adapter._write).toEqual([
        arbitraryFilePath,
        arbitraryBytes,
      ]);
    });

    test("acceptable binary content", async () => {
      const arbitraryFilePath = "test.png";
      const arbitraryBytes = "bytes"; // mock a picture binary

      await request(server)
        .put(`/vault/${arbitraryFilePath}`)
        .set("Content-Type", "image/jpeg")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send(arbitraryBytes)
        .expect(204);

      expect(app.vault.adapter._writeBinary[0]).toEqual(arbitraryFilePath);
      const data = app.vault.adapter._writeBinary[1];
      expect(Buffer.isBuffer(data) || data instanceof ArrayBuffer).toEqual(
        true
      );
      // We won't be able to convert the incoming data
      // to bytes with this mechanism in a _normal_
      // situation because those bytes won't be encodable
      // as ASCII, but we can do this here because we're
      // lying about the incoming content type above
      const decoder = new TextDecoder();
      expect(decoder.decode(data)).toEqual(arbitraryBytes);
    });

    test("non-bytes content", async () => {
      const arbitraryFilePath = "somefile.md";
      const arbitraryBytes = "bytes";

      await request(server)
        .put(`/vault/${arbitraryFilePath}`)
        .set("Content-Type", "application/json")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send(arbitraryBytes)
        .expect(400);

      expect(app.vault.adapter._write).toBeUndefined();
    });
  });

  describe("vaultPost", () => {
    test("directory", async () => {
      await request(server)
        .post("/vault/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(405);
    });

    test("unauthorized", async () => {
      const arbitraryFilePath = "somefile.md";
      const arbitraryBytes = "bytes";

      const arbitraryExistingBytes = "something\nsomething\n";

      app.vault._read = arbitraryExistingBytes;

      await request(server)
        .post(`/vault/${arbitraryFilePath}`)
        .set("Content-Type", "text/markdown")
        .send(arbitraryBytes)
        .expect(401);
    });

    describe("acceptable content", () => {
      test("existing with trailing newline", async () => {
        const arbitraryFilePath = "somefile.md";
        const arbitraryBytes = "bytes";

        const arbitraryExistingBytes = "something\nsomething\n";

        app.vault._read = arbitraryExistingBytes;

        await request(server)
          .post(`/vault/${arbitraryFilePath}`)
          .set("Content-Type", "text/markdown")
          .set("Authorization", `Bearer ${API_KEY}`)
          .send(arbitraryBytes)
          .expect(204);

        expect(app.vault.adapter._write).toEqual([
          arbitraryFilePath,
          arbitraryExistingBytes + arbitraryBytes,
        ]);
      });

      test("existing without trailing newline", async () => {
        const arbitraryFilePath = "somefile.md";
        const arbitraryBytes = "bytes";

        const arbitraryExistingBytes = "something\nsomething";

        app.vault._read = arbitraryExistingBytes;

        await request(server)
          .post(`/vault/${arbitraryFilePath}`)
          .set("Content-Type", "text/markdown")
          .set("Authorization", `Bearer ${API_KEY}`)
          .send(arbitraryBytes)
          .expect(204);

        expect(app.vault.adapter._write).toEqual([
          arbitraryFilePath,
          arbitraryExistingBytes + "\n" + arbitraryBytes,
        ]);
      });
    });

    test("non-bytes content", async () => {
      const arbitraryFilePath = "somefile.md";
      const arbitraryBytes = "bytes";

      await request(server)
        .post(`/vault/${arbitraryFilePath}`)
        .set("Content-Type", "application/json")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send(arbitraryBytes)
        .expect(400);

      expect(app.vault.adapter._write).toBeUndefined();
    });
  });

  describe("vaultDelete", () => {
    test("directory", async () => {
      await request(server)
        .delete("/vault/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(405);
    });

    test("non-existing file with ?permanent=true", async () => {
      const arbitraryFilePath = "somefile.md";
      const arbitraryBytes = "bytes";

      app.vault.adapter._exists = false;

      await request(server)
        .delete(`/vault/${arbitraryFilePath}?permanent=true`)
        .set("Content-Type", "text/markdown")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send(arbitraryBytes)
        .expect(404);

      expect(app.vault.adapter._remove).toBeUndefined();
    });

    test("non-existing file with default trash behavior", async () => {
      const arbitraryFilePath = "somefile.md";

      app.vault._getAbstractFileByPath = null;

      await request(server)
        .delete(`/vault/${arbitraryFilePath}`)
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(404);

      expect(app.fileManager._trashFile).toBeUndefined();
    });

    test("unauthorized", async () => {
      const arbitraryFilePath = "somefile.md";
      const arbitraryBytes = "bytes";

      await request(server)
        .delete(`/vault/${arbitraryFilePath}`)
        .set("Content-Type", "text/markdown")
        .send(arbitraryBytes)
        .expect(401);
    });

    test("existing file moves to trash by default", async () => {
      const arbitraryFilePath = "somefile.md";

      await request(server)
        .delete(`/vault/${arbitraryFilePath}`)
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(204);

      expect(app.fileManager._trashFile).toEqual(app.vault._getAbstractFileByPath);
      expect(app.vault.adapter._remove).toBeUndefined();
    });

    test("existing file with ?permanent=true hard-deletes", async () => {
      const arbitraryFilePath = "somefile.md";
      const arbitraryBytes = "bytes";

      await request(server)
        .delete(`/vault/${arbitraryFilePath}?permanent=true`)
        .set("Content-Type", "text/markdown")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send(arbitraryBytes)
        .expect(204);

      expect(app.vault.adapter._remove).toEqual([arbitraryFilePath]);
      expect(app.fileManager._trashFile).toBeUndefined();
    });

    test("?permanent=false is equivalent to omitting the parameter", async () => {
      const arbitraryFilePath = "somefile.md";

      await request(server)
        .delete(`/vault/${arbitraryFilePath}?permanent=false`)
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(204);

      expect(app.fileManager._trashFile).toEqual(app.vault._getAbstractFileByPath);
      expect(app.vault.adapter._remove).toBeUndefined();
    });
  });

  describe("vaultMove", () => {
    test("directory path rejected", async () => {
      await request(server)
        .move("/vault/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Destination", "somewhere/file.md")
        .expect(405);
    });

    test("successful move", async () => {
      const oldPath = "folder/file.md";
      const newPath = "another-folder/subfolder/file.md";
      jest.spyOn(handler.operations, "moveVaultFile").mockResolvedValue(newPath);

      const response = await request(server)
        .move(`/vault/${oldPath}`)
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Destination", newPath)
        .expect(204);

      expect(response.headers["content-location"]).toEqual(newPath);
      expect(handler.operations.moveVaultFile).toHaveBeenCalledWith(
        oldPath,
        newPath,
        false,
      );
    });

    test("move to vault root", async () => {
      jest.spyOn(handler.operations, "moveVaultFile").mockResolvedValue("file.md");

      await request(server)
        .move("/vault/deep/nested/file.md")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Destination", "file.md")
        .expect(204);
    });

    test("non-existent source file returns 404", async () => {
      jest
        .spyOn(handler.operations, "moveVaultFile")
        .mockRejectedValue(new FileNotFoundError("not found"));

      await request(server)
        .move("/vault/non-existent.md")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Destination", "new-location/file.md")
        .expect(404);
    });

    test("destination already exists returns 409", async () => {
      jest
        .spyOn(handler.operations, "moveVaultFile")
        .mockRejectedValue(new DestinationAlreadyExistsError("exists"));

      const response = await request(server)
        .move("/vault/folder/file.md")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Destination", "another-folder/existing-file.md")
        .expect(409);

      expect(response.body.message).toContain("Destination file already exists");
    });

    test("missing Destination header returns 400", async () => {
      const response = await request(server)
        .move("/vault/folder/file.md")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(400);

      expect(response.body.message).toContain("Destination header is required");
    });

    test("destination with trailing slash uses source filename", async () => {
      jest.spyOn(handler.operations, "moveVaultFile").mockResolvedValue("new-folder/file.md");

      const response = await request(server)
        .move("/vault/folder/file.md")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Destination", "new-folder/")
        .expect(204);

      expect(response.headers["content-location"]).toEqual("new-folder/file.md");
      expect(handler.operations.moveVaultFile).toHaveBeenCalledWith(
        "folder/file.md",
        "new-folder/file.md",
        false,
      );
    });

    test("Allow-Overwrite: true passes flag to moveVaultFile", async () => {
      jest.spyOn(handler.operations, "moveVaultFile").mockResolvedValue("another-folder/existing-file.md");

      await request(server)
        .move("/vault/folder/file.md")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Destination", "another-folder/existing-file.md")
        .set("Allow-Overwrite", "true")
        .expect(204);

      expect(handler.operations.moveVaultFile).toHaveBeenCalledWith(
        "folder/file.md",
        "another-folder/existing-file.md",
        true,
      );
    });

    test("path traversal attempt returns 400", async () => {
      const response = await request(server)
        .move("/vault/folder/file.md")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Destination", "../../../etc/passwd")
        .expect(400);

      expect(response.body.errorCode).toEqual(40021);
      expect(response.body.message).toContain("Path traversal is not allowed");
    });

    test("absolute destination path returns 400", async () => {
      const response = await request(server)
        .move("/vault/folder/file.md")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Destination", "/etc/passwd")
        .expect(400);

      expect(response.body.errorCode).toEqual(40021);
    });

    test("destination starting with /vault/ returns 400", async () => {
      const response = await request(server)
        .move("/vault/folder/file.md")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Destination", "/vault/notes/file.md")
        .expect(400);

      expect(response.body.errorCode).toEqual(40021);
    });

    test("destination with '..' as a substring (not a segment) is accepted", async () => {
      jest.spyOn(handler.operations, "moveVaultFile").mockResolvedValue("archive/notes..md");

      await request(server)
        .move("/vault/folder/file.md")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Destination", "archive/notes..md")
        .expect(204);

      expect(handler.operations.moveVaultFile).toHaveBeenCalledWith(
        "folder/file.md",
        "archive/notes..md",
        false,
      );
    });

    test("whitespace-only Destination moves file to vault root", async () => {
      jest.spyOn(handler.operations, "moveVaultFile").mockResolvedValue("file.md");

      const response = await request(server)
        .move("/vault/folder/file.md")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Destination", "   ")
        .expect(204);

      expect(response.headers["content-location"]).toEqual("file.md");
      expect(handler.operations.moveVaultFile).toHaveBeenCalledWith(
        "folder/file.md",
        "file.md",
        false,
      );
    });

    test("malformed percent-encoding in Destination returns 400", async () => {
      const response = await request(server)
        .move("/vault/folder/file.md")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Destination", "%E0%")
        .expect(400);

      expect(response.body.errorCode).toEqual(40022);
    });

    test("unauthorized", async () => {
      await request(server)
        .move("/vault/file.md")
        .set("Destination", "other/file.md")
        .expect(401);
    });
  });

  describe("vaultCopy", () => {
    test("directory path rejected", async () => {
      await request(server)
        .copy("/vault/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Destination", "somewhere/file.md")
        .expect(405);
    });

    test("successful copy", async () => {
      const sourcePath = "folder/file.md";
      const newPath = "another-folder/subfolder/file.md";
      jest.spyOn(handler.operations, "copyVaultFile").mockResolvedValue(newPath);

      const response = await request(server)
        .copy(`/vault/${sourcePath}`)
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Destination", newPath)
        .expect(204);

      expect(response.headers["content-location"]).toEqual(newPath);
      expect(handler.operations.copyVaultFile).toHaveBeenCalledWith(
        sourcePath,
        newPath,
        false,
      );
    });

    test("non-existent source file returns 404", async () => {
      jest
        .spyOn(handler.operations, "copyVaultFile")
        .mockRejectedValue(new FileNotFoundError("not found"));

      await request(server)
        .copy("/vault/non-existent.md")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Destination", "new-location/file.md")
        .expect(404);
    });

    test("destination already exists returns 409", async () => {
      jest
        .spyOn(handler.operations, "copyVaultFile")
        .mockRejectedValue(new DestinationAlreadyExistsError("exists"));

      const response = await request(server)
        .copy("/vault/folder/file.md")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Destination", "another-folder/existing-file.md")
        .expect(409);

      expect(response.body.message).toContain("Destination file already exists");
    });

    test("missing Destination header returns 400", async () => {
      const response = await request(server)
        .copy("/vault/folder/file.md")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(400);

      expect(response.body.message).toContain("Destination header is required");
    });

    test("destination with trailing slash uses source filename", async () => {
      jest.spyOn(handler.operations, "copyVaultFile").mockResolvedValue("new-folder/file.md");

      const response = await request(server)
        .copy("/vault/folder/file.md")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Destination", "new-folder/")
        .expect(204);

      expect(response.headers["content-location"]).toEqual("new-folder/file.md");
      expect(handler.operations.copyVaultFile).toHaveBeenCalledWith(
        "folder/file.md",
        "new-folder/file.md",
        false,
      );
    });

    test("Allow-Overwrite: true passes flag to copyVaultFile", async () => {
      jest.spyOn(handler.operations, "copyVaultFile").mockResolvedValue("another-folder/existing-file.md");

      await request(server)
        .copy("/vault/folder/file.md")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Destination", "another-folder/existing-file.md")
        .set("Allow-Overwrite", "true")
        .expect(204);

      expect(handler.operations.copyVaultFile).toHaveBeenCalledWith(
        "folder/file.md",
        "another-folder/existing-file.md",
        true,
      );
    });

    test("path traversal attempt returns 400", async () => {
      const response = await request(server)
        .copy("/vault/folder/file.md")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Destination", "../../../etc/passwd")
        .expect(400);

      expect(response.body.errorCode).toEqual(40021);
      expect(response.body.message).toContain("Path traversal is not allowed");
    });

    test("absolute destination path returns 400", async () => {
      const response = await request(server)
        .copy("/vault/folder/file.md")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Destination", "/etc/passwd")
        .expect(400);

      expect(response.body.errorCode).toEqual(40021);
    });

    test("malformed percent-encoding in Destination returns 400", async () => {
      const response = await request(server)
        .copy("/vault/folder/file.md")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Destination", "%E0%")
        .expect(400);

      expect(response.body.errorCode).toEqual(40022);
    });

    test("unauthorized", async () => {
      await request(server)
        .copy("/vault/file.md")
        .set("Destination", "other/file.md")
        .expect(401);
    });
  });

  describe("vaultPatch", () => {
    test("directory", async () => {
      await request(server)
        .patch("/vault/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(405);
    });

    test("missing Target-Type header", async () => {
      await request(server)
        .patch("/vault/somefile.md")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Content-Type", "text/markdown")
        .send("bytes")
        .expect(400);
    });

    test("non-existing file via Target-Type header returns 404", async () => {
      app.vault._getAbstractFileByPath = null;

      await request(server)
        .patch("/vault/somefile.md")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Content-Type", "text/markdown")
        .set("Target-Type", "heading")
        .set("Target", "Heading1")
        .set("Operation", "append")
        .send("new content")
        .expect(404);
    });

    test("FrontmatterParseError returns 400 with errorCode 40005", async () => {
      jest.spyOn(handler.operations, "patchFileSection").mockRejectedValueOnce(
        new FrontmatterParseError("YAML parse error on line 2: nested mappings are not allowed")
      );
      const res = await request(server)
        .patch("/vault/somefile.md")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Content-Type", "text/markdown")
        .set("Target-Type", "heading")
        .set("Target", "Heading1")
        .set("Operation", "append")
        .send("new content");
      expect(res.status).toBe(400);
      expect(res.body.errorCode).toBe(40005);
    });

    test("Target-Type: frontmatter with Target-Scope: marker returns 400 with errorCode 40059", async () => {
      const res = await request(server)
        .patch("/vault/somefile.md")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Target-Type", "frontmatter")
        .set("Target", "title")
        .set("Target-Scope", "marker")
        .set("Operation", "replace")
        .send("new value");
      expect(res.status).toBe(400);
      expect(res.body.errorCode).toBe(40059);
    });

    test("Target-Type: frontmatter with Target-Scope: markerAndContent returns 400 with errorCode 40059", async () => {
      const res = await request(server)
        .patch("/vault/somefile.md")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Target-Type", "frontmatter")
        .set("Target", "title")
        .set("Target-Scope", "markerAndContent")
        .set("Operation", "replace")
        .send("new value");
      expect(res.status).toBe(400);
      expect(res.body.errorCode).toBe(40059);
    });

    test("Target-Type: frontmatter with Target-Scope: content is accepted", async () => {
      jest.spyOn(handler.operations, "patchFileSection").mockResolvedValueOnce("patched");
      const res = await request(server)
        .patch("/vault/somefile.md")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Content-Type", "application/json")
        .set("Target-Type", "frontmatter")
        .set("Target", "title")
        .set("Target-Scope", "content")
        .set("Operation", "replace")
        .send('"new value"');
      expect(res.status).toBe(200);
    });

    test("Target-Type: heading with Target-Scope: marker is accepted", async () => {
      jest.spyOn(handler.operations, "patchFileSection").mockResolvedValueOnce("patched");
      const res = await request(server)
        .patch("/vault/somefile.md")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Content-Type", "text/markdown")
        .set("Target-Type", "heading")
        .set("Target", "Heading1")
        .set("Target-Scope", "marker")
        .set("Operation", "replace")
        .send("## New Heading");
      expect(res.status).toBe(200);
    });

  });

  describe("path traversal prevention", () => {
    // Two ..%2F segments are enough to escape the synthetic /vault root.
    const traversal = "/vault/..%2F..%2Fetc%2Fpasswd";

    test("GET rejects ..%2F traversal with 400 and errorCode 40021", async () => {
      const res = await request(server)
        .get(traversal)
        .set("Authorization", `Bearer ${API_KEY}`);
      expect(res.status).toBe(400);
      expect(res.body.errorCode).toBe(40021);
    });

    test("PUT rejects ..%2F traversal with 400 and errorCode 40021", async () => {
      const res = await request(server)
        .put(traversal)
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Content-Type", "text/markdown")
        .send("pwned");
      expect(res.status).toBe(400);
      expect(res.body.errorCode).toBe(40021);
    });

    test("POST rejects ..%2F traversal with 400 and errorCode 40021", async () => {
      const res = await request(server)
        .post(traversal)
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Content-Type", "text/markdown")
        .send("pwned");
      expect(res.status).toBe(400);
      expect(res.body.errorCode).toBe(40021);
    });

    test("PATCH rejects ..%2F traversal with 400 and errorCode 40021", async () => {
      const res = await request(server)
        .patch(traversal)
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Content-Type", "text/markdown")
        .set("Target-Type", "heading")
        .set("Target", "Heading1")
        .set("Operation", "append")
        .send("pwned");
      expect(res.status).toBe(400);
      expect(res.body.errorCode).toBe(40021);
    });

    test("DELETE rejects ..%2F traversal with 400 and errorCode 40021", async () => {
      const res = await request(server)
        .delete(traversal)
        .set("Authorization", `Bearer ${API_KEY}`);
      expect(res.status).toBe(400);
      expect(res.body.errorCode).toBe(40021);
    });

    test("MOVE rejects ..%2F traversal in source path with 400 and errorCode 40021", async () => {
      const res = await request(server)
        .move(traversal)
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Destination", "safe/destination.md");
      expect(res.status).toBe(400);
      expect(res.body.errorCode).toBe(40021);
    });

    test("COPY rejects ..%2F traversal in source path with 400 and errorCode 40021", async () => {
      const res = await request(server)
        .copy(traversal)
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Destination", "safe/destination.md");
      expect(res.status).toBe(400);
      expect(res.body.errorCode).toBe(40021);
    });
  });

  describe("tagsGet", () => {
    test("aggregates tags from markdown files", async () => {
      const file1 = new TFile();
      file1.path = "note1.md";
      const file2 = new TFile();
      file2.path = "note2.md";
      app.vault._markdownFiles = [file1, file2];

      const cache1 = new CachedMetadata();
      cache1.tags = [{ tag: "#project" }, { tag: "#important" }];
      const cache2 = new CachedMetadata();
      cache2.tags = [{ tag: "#project" }, { tag: "#work/tasks" }];

      app.metadataCache.getFileCache = (file: TFile) => {
        if (file.path === "note1.md") return cache1;
        if (file.path === "note2.md") return cache2;
        return null;
      };

      const result = await request(server)
        .get("/tags/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(200);

      expect(result.body.tags).toEqual(
        expect.arrayContaining([
          { name: "project", count: 2 },
          { name: "important", count: 1 },
          { name: "work", count: 1 },
          { name: "work/tasks", count: 1 },
        ]),
      );
      expect(result.body.tags).toHaveLength(4);
    });

    test("counts frontmatter tags", async () => {
      const file1 = new TFile();
      file1.path = "note1.md";
      app.vault._markdownFiles = [file1];

      const cache1 = new CachedMetadata();
      cache1.frontmatter = { tags: ["project", "important"] };

      app.metadataCache.getFileCache = () => cache1;

      const result = await request(server)
        .get("/tags/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(200);

      expect(result.body.tags).toEqual(
        expect.arrayContaining([
          { name: "project", count: 1 },
          { name: "important", count: 1 },
        ]),
      );
      expect(result.body.tags).toHaveLength(2);
    });

    test("handles files with no cache", async () => {
      const file1 = new TFile();
      app.vault._markdownFiles = [file1];
      app.metadataCache.getFileCache = () => null;

      const result = await request(server)
        .get("/tags/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(200);

      expect(result.body.tags).toEqual([]);
    });

    test("handles files with no tags", async () => {
      const file1 = new TFile();
      app.vault._markdownFiles = [file1];
      const emptyCache = new CachedMetadata();
      emptyCache.tags = [];
      app.metadataCache.getFileCache = () => emptyCache;

      const result = await request(server)
        .get("/tags/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(200);

      expect(result.body.tags).toEqual([]);
    });

    test("merges inline (#-prefixed) and frontmatter (no-#) forms of the same tag", async () => {
      const file1 = new TFile();
      file1.path = "note1.md";
      const file2 = new TFile();
      file2.path = "note2.md";
      app.vault._markdownFiles = [file1, file2];

      // note1 has the tag as an inline #project
      const cache1 = new CachedMetadata();
      cache1.tags = [{ tag: "#project" }];

      // note2 has the same tag via frontmatter (no # prefix)
      const cache2 = new CachedMetadata();
      cache2.frontmatter = { tags: ["project"] };

      app.metadataCache.getFileCache = (file: TFile) => {
        if (file.path === "note1.md") return cache1;
        if (file.path === "note2.md") return cache2;
        return null;
      };

      const result = await request(server)
        .get("/tags/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(200);

      expect(result.body.tags).toEqual([{ name: "project", count: 2 }]);
    });

    test("unauthorized", async () => {
      await request(server).get("/tags/").expect(401);
    });
  })

    
  describe("URL-embedded targets", () => {
    const markdown = [
      "---",
      "title: Test Doc",
      "---",
      "# Heading1",
      "Content under heading1",
      "## SubHeading",
      "Sub content",
      "# Heading2",
      "Content under heading2",
      "",
    ].join("\n");

    function setFileContent(content: string): void {
      app.vault._read = content;
      app.vault.adapter._read = content;
      const buf = new ArrayBuffer(content.length);
      const view = new Uint8Array(buf);
      for (let i = 0; i < content.length; i++) {
        view[i] = content.charCodeAt(i);
      }
      app.vault.adapter._readBinary = buf;
    }

    beforeEach(() => {
      // Only return a valid stat for the bare file path so that the
      // walk-backward resolver correctly identifies "somefile.md" as the
      // file and the remaining URL segments as the target.
      app.vault.adapter._statForPath = "somefile.md";
      setFileContent(markdown);
    });

    describe("GET", () => {
      test("heading via URL segments returns section content", async () => {
        const result = await request(server)
          .get("/vault/somefile.md/heading/Heading2")
          .set("Authorization", `Bearer ${API_KEY}`)
          .expect(200);

        expect(result.text).toEqual("Content under heading2\n");
      });

      test("nested heading via URL segments", async () => {
        const result = await request(server)
          .get("/vault/somefile.md/heading/Heading1/SubHeading")
          .set("Authorization", `Bearer ${API_KEY}`)
          .expect(200);

        expect(result.text).toEqual("Sub content\n");
      });

      test("frontmatter via URL segments returns JSON value", async () => {
        const result = await request(server)
          .get("/vault/somefile.md/frontmatter/title")
          .set("Authorization", `Bearer ${API_KEY}`)
          .expect(200);

        expect(result.body).toEqual("Test Doc");
      });

      test("URL target + Target-Type header returns 422", async () => {
        await request(server)
          .get("/vault/somefile.md/heading/Heading1")
          .set("Authorization", `Bearer ${API_KEY}`)
          .set("Target-Type", "heading")
          .expect(422);
      });

      test("URL target + Target header returns 422", async () => {
        await request(server)
          .get("/vault/somefile.md/heading/Heading1")
          .set("Authorization", `Bearer ${API_KEY}`)
          .set("Target", "Heading1")
          .expect(422);
      });

      test("non-existent file in URL path returns 404", async () => {
        app.vault.adapter._exists = false;

        await request(server)
          .get("/vault/somefile.md/heading/Heading1")
          .set("Authorization", `Bearer ${API_KEY}`)
          .expect(404);
      });
    });

    describe("PUT", () => {
      test("replaces section content via URL target", async () => {
        const result = await request(server)
          .put("/vault/somefile.md/heading/Heading2")
          .set("Authorization", `Bearer ${API_KEY}`)
          .set("Content-Type", "text/markdown")
          .send("Replaced content\n")
          .expect(200);

        expect(result.text).toContain("Replaced content");
        expect(result.text).not.toContain("Content under heading2");
      });

      test("URL target + Target-Type header returns 422", async () => {
        await request(server)
          .put("/vault/somefile.md/heading/Heading2")
          .set("Authorization", `Bearer ${API_KEY}`)
          .set("Content-Type", "text/markdown")
          .set("Target-Type", "heading")
          .send("content")
          .expect(422);
      });

      test("frontmatter URL target with Target-Scope: marker returns 400 with errorCode 40059", async () => {
        const res = await request(server)
          .put("/vault/somefile.md/frontmatter/title")
          .set("Authorization", `Bearer ${API_KEY}`)
          .set("Content-Type", "application/json")
          .set("Target-Scope", "marker")
          .send('"New Title"');
        expect(res.status).toBe(400);
        expect(res.body.errorCode).toBe(40059);
      });
    });

    describe("POST", () => {
      test("appends to section via URL target", async () => {
        const result = await request(server)
          .post("/vault/somefile.md/heading/Heading2")
          .set("Authorization", `Bearer ${API_KEY}`)
          .set("Content-Type", "text/markdown")
          .send("Appended content\n")
          .expect(200);

        expect(result.text).toContain("Content under heading2");
        expect(result.text).toContain("Appended content");
      });

      test("URL target + Target header returns 422", async () => {
        await request(server)
          .post("/vault/somefile.md/heading/Heading2")
          .set("Authorization", `Bearer ${API_KEY}`)
          .set("Content-Type", "text/markdown")
          .set("Target", "Heading2")
          .send("content")
          .expect(422);
      });
    });

    describe("DELETE", () => {
      test("targeted DELETE returns 405", async () => {
        await request(server)
          .delete("/vault/somefile.md/heading/Heading2")
          .set("Authorization", `Bearer ${API_KEY}`)
          .expect(405);
      });
    });
  });

  describe("commandGet", () => {
    test("acceptable", async () => {
      const arbitraryCommand = new Command();
      arbitraryCommand.id = "beep";
      arbitraryCommand.name = "boop";

      app.commands.commands[arbitraryCommand.id] = arbitraryCommand;

      const result = await request(server)
        .get(`/commands/`)
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(200);

      expect(result.body.commands).toEqual([
        {
          id: arbitraryCommand.id,
          name: arbitraryCommand.name,
        },
      ]);
    });

    test("unauthorized", async () => {
      const arbitraryCommand = new Command();
      arbitraryCommand.id = "beep";
      arbitraryCommand.name = "boop";

      app.commands.commands[arbitraryCommand.id] = arbitraryCommand;

      await request(server).get(`/commands/`).expect(401);
    });
  });

  describe("commandPost", () => {
    test("acceptable", async () => {
      const arbitraryCommand = new Command();
      arbitraryCommand.id = "beep";
      arbitraryCommand.name = "boop";

      app.commands.commands[arbitraryCommand.id] = arbitraryCommand;

      await request(server)
        .post(`/commands/${arbitraryCommand.id}/`)
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(204);

      expect(app._executeCommandById).toEqual([arbitraryCommand.id]);
    });

    test("command not found returns 404", async () => {
      await request(server)
        .post(`/commands/nonexistent-command/`)
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(404);
    });

    test("command execution error returns 500", async () => {
      const arbitraryCommand = new Command();
      arbitraryCommand.id = "beep";
      arbitraryCommand.name = "boop";

      app.commands.commands[arbitraryCommand.id] = arbitraryCommand;
      app.commands.executeCommandById = () => {
        throw new Error("command crashed");
      };

      await request(server)
        .post(`/commands/${arbitraryCommand.id}/`)
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(500);
    });

    test("unauthorized", async () => {
      const arbitraryCommand = new Command();
      arbitraryCommand.id = "beep";
      arbitraryCommand.name = "boop";

      app.commands.commands[arbitraryCommand.id] = arbitraryCommand;

      await request(server)
        .post(`/commands/${arbitraryCommand.id}`)
        .expect(401);
    });
  });

  describe("searchSimplePost", () => {
    beforeEach(() => {
      // Setup mock for prepareSimpleSearch
      _prepareSimpleSearchMock.behavior = (query: string) => {
        const queryLower = query.toLowerCase();
        const queryLength = query.length;
        return (text: string) => {
          const textLower = text.toLowerCase();
          const matches: [number, number][] = [];
          let index = 0;

          // Find all matches (case-insensitive)
          while ((index = textLower.indexOf(queryLower, index)) !== -1) {
            matches.push([index, index + queryLength]);
            index += 1;
          }

          if (matches.length === 0) {
            return null;
          }

          // Calculate score based on number of matches
          const score = matches.length;

          return {
            score,
            matches,
          };
        };
      };
    });

    afterEach(() => {
      // Clean up mock
      _prepareSimpleSearchMock.behavior = null;
    });

    test("match at beginning of filename", async () => {
      const testFile = new TFile();
      testFile.basename = "Master Plan";
      testFile.path = "Master Plan.md";

      app.vault._markdownFiles = [testFile];
      app.vault._cachedRead = "Some content here";

      const result = await request(server)
        .post("/search/simple/?query=Master")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(200);

      expect(result.body).toHaveLength(1);
      expect(result.body[0].filename).toBe("Master Plan.md");
      expect(result.body[0].matches).toHaveLength(1);
      expect(result.body[0].matches[0].match.source).toBe("filename");
      expect(result.body[0].matches[0].match.start).toBe(0);
      expect(result.body[0].matches[0].match.end).toBe(6);
      expect(result.body[0].matches[0].context).toBe("Master Plan");
    });

    test("match in middle of filename", async () => {
      const testFile = new TFile();
      testFile.basename = "1 - Master Plan";
      testFile.path = "1 - Master Plan.md";

      app.vault._markdownFiles = [testFile];
      app.vault._cachedRead = "Some content here";

      const result = await request(server)
        .post("/search/simple/?query=Master")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(200);

      expect(result.body).toHaveLength(1);
      expect(result.body[0].filename).toBe("1 - Master Plan.md");
      expect(result.body[0].matches).toHaveLength(1);
      expect(result.body[0].matches[0].match.source).toBe("filename");
      expect(result.body[0].matches[0].match.start).toBe(4);
      expect(result.body[0].matches[0].match.end).toBe(10);
      expect(result.body[0].matches[0].context).toBe("1 - Master Plan");
    });

    test("match at end of filename", async () => {
      const testFile = new TFile();
      testFile.basename = "My Master Plan";
      testFile.path = "My Master Plan.md";

      app.vault._markdownFiles = [testFile];
      app.vault._cachedRead = "Some content here";

      const result = await request(server)
        .post("/search/simple/?query=Plan")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(200);

      expect(result.body).toHaveLength(1);
      expect(result.body[0].filename).toBe("My Master Plan.md");
      expect(result.body[0].matches).toHaveLength(1);
      expect(result.body[0].matches[0].match.source).toBe("filename");
      expect(result.body[0].matches[0].match.start).toBe(10);
      expect(result.body[0].matches[0].match.end).toBe(14);
      expect(result.body[0].matches[0].context).toBe("My Master Plan");
    });

    test("match in content only", async () => {
      const testFile = new TFile();
      testFile.basename = "Random Note";
      testFile.path = "Random Note.md";

      app.vault._markdownFiles = [testFile];
      app.vault._cachedRead = "This is my master plan for the project.";

      const result = await request(server)
        .post("/search/simple/?query=master")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(200);

      expect(result.body).toHaveLength(1);
      expect(result.body[0].filename).toBe("Random Note.md");
      expect(result.body[0].matches).toHaveLength(1);
      expect(result.body[0].matches[0].match.source).toBe("content");
      expect(result.body[0].matches[0].match.start).toBe(11);
      expect(result.body[0].matches[0].match.end).toBe(17);
    });

    test("match in both filename and content", async () => {
      const testFile = new TFile();
      testFile.basename = "Master Plan";
      testFile.path = "Master Plan.md";

      app.vault._markdownFiles = [testFile];
      app.vault._cachedRead = "The master plan is to complete this project.";

      const result = await request(server)
        .post("/search/simple/?query=master")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(200);

      expect(result.body).toHaveLength(1);
      expect(result.body[0].filename).toBe("Master Plan.md");
      expect(result.body[0].matches).toHaveLength(2);

      // First match should be in filename (case-insensitive)
      expect(result.body[0].matches[0].match.source).toBe("filename");
      expect(result.body[0].matches[0].match.start).toBe(0);
      expect(result.body[0].matches[0].match.end).toBe(6);
      expect(result.body[0].matches[0].context).toBe("Master Plan");

      // Second match should be in content
      expect(result.body[0].matches[1].match.source).toBe("content");
      expect(result.body[0].matches[1].match.start).toBe(4);
      expect(result.body[0].matches[1].match.end).toBe(10);
    });

    test("multiple matches in filename", async () => {
      const testFile = new TFile();
      testFile.basename = "Test Test Test";
      testFile.path = "Test Test Test.md";

      app.vault._markdownFiles = [testFile];
      app.vault._cachedRead = "Content without the search term";

      const result = await request(server)
        .post("/search/simple/?query=Test")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(200);

      expect(result.body).toHaveLength(1);
      expect(result.body[0].filename).toBe("Test Test Test.md");
      expect(result.body[0].matches).toHaveLength(3);

      // All matches should be in filename
      expect(result.body[0].matches[0].match.source).toBe("filename");
      expect(result.body[0].matches[0].match.start).toBe(0);
      expect(result.body[0].matches[0].match.end).toBe(4);

      expect(result.body[0].matches[1].match.source).toBe("filename");
      expect(result.body[0].matches[1].match.start).toBe(5);
      expect(result.body[0].matches[1].match.end).toBe(9);

      expect(result.body[0].matches[2].match.source).toBe("filename");
      expect(result.body[0].matches[2].match.start).toBe(10);
      expect(result.body[0].matches[2].match.end).toBe(14);
    });

    test("filename with special characters", async () => {
      const testFile = new TFile();
      testFile.basename = "Project (2024) - Master Plan";
      testFile.path = "Project (2024) - Master Plan.md";

      app.vault._markdownFiles = [testFile];
      app.vault._cachedRead = "Project details";

      const result = await request(server)
        .post("/search/simple/?query=2024")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(200);

      expect(result.body).toHaveLength(1);
      expect(result.body[0].filename).toBe("Project (2024) - Master Plan.md");
      expect(result.body[0].matches).toHaveLength(1);
      expect(result.body[0].matches[0].match.source).toBe("filename");
      expect(result.body[0].matches[0].match.start).toBe(9);
      expect(result.body[0].matches[0].match.end).toBe(13);
      expect(result.body[0].matches[0].context).toBe("Project (2024) - Master Plan");
    });

    test("context length for content matches", async () => {
      const testFile = new TFile();
      testFile.basename = "Note";
      testFile.path = "Note.md";

      const longContent = "A".repeat(200) + "MATCH" + "B".repeat(200);
      app.vault._markdownFiles = [testFile];
      app.vault._cachedRead = longContent;

      const result = await request(server)
        .post("/search/simple/?query=MATCH&contextLength=50")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(200);

      expect(result.body).toHaveLength(1);
      expect(result.body[0].matches).toHaveLength(1);
      expect(result.body[0].matches[0].match.source).toBe("content");

      // Context should be approximately 50 chars before + match + 50 chars after
      const context = result.body[0].matches[0].context;
      expect(context.length).toBeLessThanOrEqual(105); // 50 + 5 + 50
      expect(context).toContain("MATCH");
    });

    test("no matches returns empty array", async () => {
      const testFile = new TFile();
      testFile.basename = "Random Note";
      testFile.path = "Random Note.md";

      app.vault._markdownFiles = [testFile];
      app.vault._cachedRead = "Some content";

      const result = await request(server)
        .post("/search/simple/?query=NonExistentTerm")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(200);

      expect(result.body).toHaveLength(0);
    });

    test("case insensitive search", async () => {
      const testFile = new TFile();
      testFile.basename = "MASTER Plan";
      testFile.path = "MASTER Plan.md";

      app.vault._markdownFiles = [testFile];
      app.vault._cachedRead = "master plan details";

      const result = await request(server)
        .post("/search/simple/?query=master")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(200);

      expect(result.body).toHaveLength(1);
      expect(result.body[0].matches).toHaveLength(2);

      // Should match "MASTER" in filename (case-insensitive)
      expect(result.body[0].matches[0].match.source).toBe("filename");
      expect(result.body[0].matches[0].match.start).toBe(0);
      expect(result.body[0].matches[0].match.end).toBe(6);

      // Should match "master" in content
      expect(result.body[0].matches[1].match.source).toBe("content");
      expect(result.body[0].matches[1].match.start).toBe(0);
      expect(result.body[0].matches[1].match.end).toBe(6);
    });

    test("boundary-spanning matches are filtered out", async () => {
      // This test verifies that matches spanning from filename into content are skipped.
      // When searching for a term that bridges the filename and content (e.g., "Master\n\nThe"),
      // such matches would produce invalid results (negative start positions).
      const testFile = new TFile();
      testFile.basename = "Master";
      testFile.path = "Master.md";

      app.vault._markdownFiles = [testFile];
      app.vault._cachedRead = "The content starts here";

      // Mock prepareSimpleSearch to return a boundary-spanning match
      _prepareSimpleSearchMock.behavior = (query: string) => {
        return (text: string) => {
          // Simulate a match that spans from filename into content
          // filename "Master" + "\n\n" = 8 chars (positionOffset)
          // A boundary-spanning match would have start < 8 and end > 8
          const matches: [number, number][] = [
            [0, 11], // Spans from "Master" (0) into content "The" (ends at 11)
          ];
          return {
            score: 1,
            matches,
          };
        };
      };

      const result = await request(server)
        .post("/search/simple/?query=Master%0A%0AThe")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(200);

      // The file should still be in results (because there was a match)
      expect(result.body).toHaveLength(1);
      // But the boundary-spanning match should be filtered out
      expect(result.body[0].matches).toHaveLength(0);
    });

    test("boundary-spanning matches don't affect valid matches", async () => {
      // Verify that when there are both boundary-spanning and valid matches,
      // only the valid ones are returned
      const testFile = new TFile();
      testFile.basename = "Master";
      testFile.path = "Master.md";

      app.vault._markdownFiles = [testFile];
      app.vault._cachedRead = "The Master plan content";

      // Mock prepareSimpleSearch to return both valid and boundary-spanning matches
      _prepareSimpleSearchMock.behavior = (query: string) => {
        return (text: string) => {
          // text = "Master\n\n" + "The Master plan content"
          // positionOffset = 8
          const matches: [number, number][] = [
            [0, 11],  // Boundary-spanning: starts in filename, ends in content (should be filtered)
            [0, 6],   // Valid: entirely in filename "Master" (should be kept)
            [12, 18], // Valid: "Master" in content at position 4, adjusted = 12-8=4, 18-8=10 (should be kept)
          ];
          return {
            score: 3,
            matches,
          };
        };
      };

      const result = await request(server)
        .post("/search/simple/?query=Master")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(200);

      expect(result.body).toHaveLength(1);
      // Only 2 valid matches should be returned (boundary-spanning filtered out)
      expect(result.body[0].matches).toHaveLength(2);

      // First match: filename
      expect(result.body[0].matches[0].match.source).toBe("filename");
      expect(result.body[0].matches[0].match.start).toBe(0);
      expect(result.body[0].matches[0].match.end).toBe(6);

      // Second match: content (position adjusted by positionOffset)
      expect(result.body[0].matches[1].match.source).toBe("content");
      expect(result.body[0].matches[1].match.start).toBe(4);  // 12 - 8
      expect(result.body[0].matches[1].match.end).toBe(10);   // 18 - 8
    });

    test("unauthorized", async () => {
      await request(server)
        .post("/search/simple/?query=test")
        .expect(401);
    });

    test("missing query parameter", async () => {
      await request(server)
        .post("/search/simple/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(400);
    });
  });

  describe("searchQueryPost", () => {
    test("returns matching files for a frontmatter query", async () => {
      const file1 = new TFile();
      file1.path = "match.md";
      const file2 = new TFile();
      file2.path = "no-match.md";
      app.vault._markdownFiles = [file1, file2];

      const cache1 = new CachedMetadata();
      cache1.frontmatter = { status: "done" };
      const cache2 = new CachedMetadata();
      cache2.frontmatter = { status: "todo" };

      app.metadataCache.getFileCache = (file: TFile) => {
        if (file.path === "match.md") return cache1;
        if (file.path === "no-match.md") return cache2;
        return null;
      };

      const result = await request(server)
        .post("/search/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Content-Type", "application/vnd.olrapi.jsonlogic+json")
        .send({ "==": [{ var: "frontmatter.status" }, "done"] })
        .expect(200);

      expect(result.body).toHaveLength(1);
      expect(result.body[0].filename).toBe("match.md");
    });

    test("does not call cachedRead when query does not reference content", async () => {
      const file1 = new TFile();
      file1.path = "note.md";
      app.vault._markdownFiles = [file1];

      const cache = new CachedMetadata();
      cache.frontmatter = { status: "done" };
      app.metadataCache.getFileCache = () => cache;

      const cachedReadSpy = jest.spyOn(app.vault, "cachedRead");

      await request(server)
        .post("/search/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Content-Type", "application/vnd.olrapi.jsonlogic+json")
        .send({ "==": [{ var: "frontmatter.status" }, "done"] })
        .expect(200);

      expect(cachedReadSpy).not.toHaveBeenCalled();
      cachedReadSpy.mockRestore();
    });

    test("calls cachedRead when query references content", async () => {
      const file1 = new TFile();
      file1.path = "note.md";
      app.vault._markdownFiles = [file1];
      app.vault._cachedRead = "hello world";

      const cache = new CachedMetadata();
      app.metadataCache.getFileCache = () => cache;

      const cachedReadSpy = jest.spyOn(app.vault, "cachedRead");

      const result = await request(server)
        .post("/search/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Content-Type", "application/vnd.olrapi.jsonlogic+json")
        .send({ in: ["hello", { var: "content" }] })
        .expect(200);

      expect(cachedReadSpy).toHaveBeenCalled();
      expect(result.body).toHaveLength(1);
      cachedReadSpy.mockRestore();
    });

    test("returns empty string for content when query does not reference content", async () => {
      const file1 = new TFile();
      file1.path = "note.md";
      app.vault._markdownFiles = [file1];
      app.vault._cachedRead = "actual file content";

      const cache = new CachedMetadata();
      app.metadataCache.getFileCache = () => cache;

      const result = await request(server)
        .post("/search/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Content-Type", "application/vnd.olrapi.jsonlogic+json")
        .send({ "==": [{ var: "path" }, "note.md"] })
        .expect(200);

      expect(result.body).toHaveLength(1);
      expect(result.body[0].filename).toBe("note.md");
    });

    test("returns 400 when content-type is missing", async () => {
      await request(server)
        .post("/search/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({ "==": [{ var: "path" }, "note.md"] })
        .expect(400);
    });

    test("returns 401 without auth", async () => {
      await request(server)
        .post("/search/")
        .set("Content-Type", "application/vnd.olrapi.jsonlogic+json")
        .send({ "==": [{ var: "path" }, "note.md"] })
        .expect(401);
    });
  });

  describe("/mcp/ routes", () => {
    test("GET /mcp/ without auth returns 401", async () => {
      await request(server).get("/mcp/").expect(401);
    });

    test("POST /mcp/ without auth returns 401", async () => {
      await request(server).post("/mcp/").expect(401);
    });

    test("POST /mcp/ with valid auth reaches McpHandler.handleRequest", async () => {
      await request(server)
        .post("/mcp/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(200);
    });

    test("GET /mcp/ with valid auth and session ID reaches McpHandler.handleRequest", async () => {
      await request(server)
        .get("/mcp/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Mcp-Session-Id", "some-session-id")
        .expect(200);
    });

    test("POST /mcp/ with unsupported MCP-Protocol-Version returns 400", async () => {
      await request(server)
        .post("/mcp/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("MCP-Protocol-Version", "9999-01-01")
        .expect(400);
    });

    test("GET /mcp/ with unsupported MCP-Protocol-Version returns 400", async () => {
      await request(server)
        .get("/mcp/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("MCP-Protocol-Version", "9999-01-01")
        .expect(400);
    });

    test("POST /mcp/ with MCP-Protocol-Version 2025-06-18 passes through", async () => {
      await request(server)
        .post("/mcp/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("MCP-Protocol-Version", "2025-06-18")
        .expect(200);
    });

    test("POST /mcp/ with MCP-Protocol-Version 2025-03-26 passes through", async () => {
      await request(server)
        .post("/mcp/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("MCP-Protocol-Version", "2025-03-26")
        .expect(200);
    });

    test("POST /mcp/ without MCP-Protocol-Version passes through", async () => {
      await request(server)
        .post("/mcp/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(200);
    });
  });

  describe("waitForFileCache", () => {
    test("returns immediately if cache is already available", async () => {
      const testFile = new TFile();
      testFile.path = "test.md";

      // Cache is already available (default mock behavior)
      app.metadataCache._getFileCache = {
        headings: [],
        frontmatter: { title: "Test" },
        tags: [],
      };

      // Access the private method via the handler instance
      // @ts-ignore: Accessing private method for testing
      const result = await handler.operations.waitForFileCache(testFile);

      expect(result).not.toBeNull();
      expect(result?.frontmatter?.title).toBe("Test");
    });

    test("waits for cache change event when cache is initially null", async () => {
      const testFile = new TFile();
      testFile.path = "test.md";

      // Start with null cache
      app.metadataCache._getFileCache = null;

      // @ts-ignore: Accessing private method for testing
      const cachePromise = handler.operations.waitForFileCache(testFile, 5000);

      // Simulate cache becoming available after a short delay
      setTimeout(() => {
        app.metadataCache._getFileCache = {
          headings: [],
          frontmatter: { title: "Loaded" },
          tags: [],
        };
        app.metadataCache._emitChanged(testFile);
      }, 50);

      const result = await cachePromise;

      expect(result).not.toBeNull();
      expect(result?.frontmatter?.title).toBe("Loaded");
    });

    test("ignores cache change events for other files", async () => {
      const testFile = new TFile();
      testFile.path = "test.md";

      const otherFile = new TFile();
      otherFile.path = "other.md";

      // Start with null cache
      app.metadataCache._getFileCache = null;

      // @ts-ignore: Accessing private method for testing
      const cachePromise = handler.operations.waitForFileCache(testFile, 200);

      // Emit change for a different file - should be ignored
      setTimeout(() => {
        app.metadataCache._emitChanged(otherFile);
      }, 20);

      // Then emit for the correct file
      setTimeout(() => {
        app.metadataCache._getFileCache = {
          headings: [],
          frontmatter: { title: "Correct" },
          tags: [],
        };
        app.metadataCache._emitChanged(testFile);
      }, 50);

      const result = await cachePromise;

      expect(result).not.toBeNull();
      expect(result?.frontmatter?.title).toBe("Correct");
    });

    test("returns current cache state on timeout", async () => {
      const testFile = new TFile();
      testFile.path = "test.md";

      // Start with null cache and never populate it
      app.metadataCache._getFileCache = null;

      // Use a very short timeout for the test
      // @ts-ignore: Accessing private method for testing
      const result = await handler.operations.waitForFileCache(testFile, 100);

      // Should return null (timeout reached without cache becoming available)
      expect(result).toBeNull();
    });

    test("cleans up event listener after cache becomes available", async () => {
      const testFile = new TFile();
      testFile.path = "test.md";

      // Start with null cache
      app.metadataCache._getFileCache = null;

      // @ts-ignore: Accessing private method for testing
      const cachePromise = handler.operations.waitForFileCache(testFile, 5000);

      // Simulate cache becoming available
      setTimeout(() => {
        app.metadataCache._getFileCache = {
          headings: [],
          frontmatter: {},
          tags: [],
        };
        app.metadataCache._emitChanged(testFile);
      }, 50);

      await cachePromise;

      // Check that the listener was removed
      const listeners = app.metadataCache._listeners.get("changed") || [];
      expect(listeners.length).toBe(0);
    });

    test("cleans up event listener on timeout", async () => {
      const testFile = new TFile();
      testFile.path = "test.md";

      // Start with null cache
      app.metadataCache._getFileCache = null;

      // @ts-ignore: Accessing private method for testing
      await handler.operations.waitForFileCache(testFile, 100);

      // Check that the listener was removed after timeout
      const listeners = app.metadataCache._listeners.get("changed") || [];
      expect(listeners.length).toBe(0);
    });
  });

  describe("unexpected error handling", () => {
    // Before the handle() wrapper was added, any unhandled rejection from an
    // async route handler was silently swallowed (void pattern), leaving the
    // HTTP request to hang forever with no response.  These tests verify that
    // unexpected errors are turned into 500 responses instead.

    test("synchronous throw inside async vault GET returns 500", async () => {
      jest.spyOn(handler.operations, "listVaultDirectory").mockImplementation(() => {
        throw new Error("Unexpected internal error");
      });
      const res = await request(server)
        .get("/vault/")
        .set("Authorization", `Bearer ${API_KEY}`);
      expect(res.status).toBe(500);
    });

    test("rejected promise from vault POST returns 500", async () => {
      jest.spyOn(handler.operations, "appendFileContent").mockRejectedValue(
        new Error("disk full"),
      );
      const res = await request(server)
        .post("/vault/some-file.md")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Content-Type", "text/plain")
        .send("hello");
      expect(res.status).toBe(500);
    });

    test("synchronous throw from periodicGetNote returns 500", async () => {
      jest.spyOn(handler.operations, "periodicGetNote").mockImplementation(() => {
        throw new Error("plugin not ready");
      });
      const res = await request(server)
        .get("/periodic/daily/")
        .set("Authorization", `Bearer ${API_KEY}`);
      expect(res.status).toBe(500);
    });

    test("rejected promise from periodicGetOrCreateNote returns 500", async () => {
      jest.spyOn(handler.operations, "periodicGetOrCreateNote").mockRejectedValue(
        new Error("plugin not ready"),
      );
      const res = await request(server)
        .patch("/periodic/daily/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Target-Type", "heading")
        .set("Operation", "append")
        .set("Target", "My Heading")
        .set("Content-Type", "text/plain")
        .send("content");
      expect(res.status).toBe(500);
    });
  });

  describe("periodicNotes", () => {
    // These tests call through to the real VaultOperations.getPeriodicNoteInterface()
    // implementation rather than mocking handler.operations.periodicGetNote/
    // periodicGetOrCreateNote. This ensures the obsidian-daily-notes-interface
    // import is exercised and regressions like #255 (undefined default import
    // causing a crash) are caught at unit-test time.

    test("unknown period name returns 404", async () => {
      const res = await request(server)
        .get("/periodic/decennial/")
        .set("Authorization", `Bearer ${API_KEY}`);
      expect(res.status).toBe(404);
    });

    test("period not enabled returns 400", async () => {
      (dailyNotesInterface.appHasDailyNotesPluginLoaded as jest.Mock).mockReturnValueOnce(false);
      const res = await request(server)
        .get("/periodic/daily/")
        .set("Authorization", `Bearer ${API_KEY}`);
      expect(res.status).toBe(400);
    });

    test("note does not exist returns 404, not a crash (regression for #255)", async () => {
      // getDailyNote returns null by default in the mock — note doesn't exist yet.
      const res = await request(server)
        .get("/periodic/daily/")
        .set("Authorization", `Bearer ${API_KEY}`);
      expect(res.status).toBe(404);
    });

    test("note exists returns 200 with file content", async () => {
      const noteFile = new TFile();
      noteFile.path = "daily.md";
      (dailyNotesInterface.getDailyNote as jest.Mock).mockReturnValueOnce(noteFile);
      (dailyNotesInterface.getAllDailyNotes as jest.Mock).mockReturnValueOnce({});

      const res = await request(server)
        .get("/periodic/daily/")
        .set("Authorization", `Bearer ${API_KEY}`);
      expect(res.status).toBe(200);
    });
  });

  describe("periodic Content-Location header", () => {
    const periodicFilePath = "daily/2024-01-15.md";

    beforeEach(() => {
      const noteFile = Object.assign(new TFile(), { path: periodicFilePath });
      jest.spyOn(handler.operations, "periodicGetNote").mockReturnValue([noteFile, null]);
      jest.spyOn(handler.operations, "periodicGetOrCreateNote").mockResolvedValue([noteFile, null]);
      app.vault.adapter._readBinary = Buffer.from("# Daily\n");
    });

    test("GET returns Content-Location", async () => {
      const res = await request(server)
        .get("/periodic/daily/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(200);
      expect(res.headers["content-location"]).toEqual(periodicFilePath);
    });

    test("PUT (whole-file replace) returns Content-Location", async () => {
      const res = await request(server)
        .put("/periodic/daily/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Content-Type", "text/markdown")
        .send("# Replaced\n")
        .expect(204);
      expect(res.headers["content-location"]).toEqual(periodicFilePath);
    });

    test("POST (append) returns Content-Location", async () => {
      const res = await request(server)
        .post("/periodic/daily/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Content-Type", "text/markdown")
        .send("appended\n")
        .expect(204);
      expect(res.headers["content-location"]).toEqual(periodicFilePath);
    });

    test("PATCH returns Content-Location", async () => {
      jest.spyOn(handler.operations, "patchFileSection").mockResolvedValue("# Patched\n");
      const res = await request(server)
        .patch("/periodic/daily/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Content-Type", "text/markdown")
        .set("Operation", "append")
        .set("Target-Type", "heading")
        .set("Target", "Daily")
        .send("appended\n")
        .expect(200);
      expect(res.headers["content-location"]).toEqual(periodicFilePath);
    });

    test("PATCH with FrontmatterParseError returns 400 with errorCode 40005", async () => {
      jest.spyOn(handler.operations, "patchFileSection").mockRejectedValueOnce(
        new FrontmatterParseError("YAML parse error on line 2: nested mappings are not allowed")
      );
      const res = await request(server)
        .patch("/periodic/daily/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Content-Type", "text/markdown")
        .set("Operation", "append")
        .set("Target-Type", "heading")
        .set("Target", "Daily")
        .send("appended\n");
      expect(res.status).toBe(400);
      expect(res.body.errorCode).toBe(40005);
    });

    test("DELETE returns Content-Location", async () => {
      const res = await request(server)
        .delete("/periodic/daily/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(204);
      expect(res.headers["content-location"]).toEqual(periodicFilePath);
    });
  });

  describe("apiExtensions", () => {
    test("addMcpTool registers a tool via McpHandler", () => {
      const extManifest = Object.assign(new PluginManifest(), { id: "test-plugin" });
      // @ts-ignore: mock PluginManifest is close enough for runtime
      const api = handler.registerApiExtension(extManifest);
      const callback = async () => "result";
      api.addMcpTool("my_tool", "Does something", {}, callback);
      // @ts-ignore: registerTool is a jest mock on the McpHandler instance
      expect(handler.mcpHandler.registerTool).toHaveBeenCalledWith("my_tool", "Does something", {}, callback, undefined);
    });

    test("unregister calls cleanup for all registered MCP tools", () => {
      const extManifest = Object.assign(new PluginManifest(), { id: "test-plugin-2" });
      // @ts-ignore: mock PluginManifest is close enough for runtime
      const api = handler.registerApiExtension(extManifest);
      const mockCleanup = jest.fn();
      // @ts-ignore: registerTool is a jest mock on the McpHandler instance
      handler.mcpHandler.registerTool.mockReturnValueOnce(mockCleanup);
      api.addMcpTool("cleanup_tool", "Desc", {}, async () => "");
      api.unregister();
      expect(mockCleanup).toHaveBeenCalledTimes(1);
    });
  });

  describe("activeFile Content-Location header", () => {
    const activeFilePath = "notes/active.md";

    beforeEach(() => {
      const activeFile = Object.assign(new TFile(), { path: activeFilePath });
      jest.spyOn(app.workspace, "getActiveFile").mockReturnValue(activeFile);
      app.vault.adapter._readBinary = Buffer.from("# Active\n");
    });

    test("GET returns Content-Location", async () => {
      const res = await request(server)
        .get("/active/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(200);
      expect(res.headers["content-location"]).toEqual(activeFilePath);
    });

    test("PUT (whole-file replace) returns Content-Location", async () => {
      const res = await request(server)
        .put("/active/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Content-Type", "text/markdown")
        .send("# Replaced\n")
        .expect(204);
      expect(res.headers["content-location"]).toEqual(activeFilePath);
    });

    test("POST (append) returns Content-Location", async () => {
      const res = await request(server)
        .post("/active/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Content-Type", "text/markdown")
        .send("appended\n")
        .expect(204);
      expect(res.headers["content-location"]).toEqual(activeFilePath);
    });

    test("PATCH returns Content-Location", async () => {
      jest.spyOn(handler.operations, "patchFileSection").mockResolvedValue("# Patched\n");
      const res = await request(server)
        .patch("/active/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Content-Type", "text/markdown")
        .set("Operation", "append")
        .set("Target-Type", "heading")
        .set("Target", "Active File")
        .send("appended\n")
        .expect(200);
      expect(res.headers["content-location"]).toEqual(activeFilePath);
    });

    test("DELETE returns Content-Location", async () => {
      const res = await request(server)
        .delete("/active/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(204);
      expect(res.headers["content-location"]).toEqual(activeFilePath);
    });
  });
});
