import { describe, expect, it } from "vitest";
import {
  renderSubsonicResponse,
  responseFormat,
  SERVER_VERSION,
  SUBSONIC_API_VERSION,
  SubsonicError,
  SubsonicErrorCode,
  type SubsonicNode,
} from "../src/subsonic/response";

async function renderOk(body: SubsonicNode, format: "xml" | "json" = "xml"): Promise<string> {
  return await renderSubsonicResponse({ status: "ok", body }, format).text();
}

async function renderFailed(error: SubsonicError, format: "xml" | "json" = "xml"): Promise<string> {
  return await renderSubsonicResponse({ status: "failed", error }, format).text();
}

describe("responseFormat", () => {
  it("defaults to XML", () => {
    expect(responseFormat(new URLSearchParams())).toBe("xml");
    expect(responseFormat(new URLSearchParams("f=xml"))).toBe("xml");
  });

  it("selects JSON only for f=json", () => {
    expect(responseFormat(new URLSearchParams("f=json"))).toBe("json");
    expect(responseFormat(new URLSearchParams("f=JSON"))).toBe("xml");
  });
});

describe("XML rendering", () => {
  it("advertises a strict X.Y.Z server version", () => {
    expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(SUBSONIC_API_VERSION).toBe("1.16.1");
  });

  it("renders the envelope with the Subsonic namespace and attributes", async () => {
    const xml = await renderOk({});

    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<subsonic-response xmlns="http://subsonic.org/restapi" status="ok" version="1.16.1"' +
        ` type="stratosonic" serverVersion="${SERVER_VERSION}" openSubsonic="true"/>`,
    );
  });

  it("defaults to HTTP 200 and honours an explicit status", () => {
    const payload = {
      status: "failed",
      error: new SubsonicError(SubsonicErrorCode.Generic),
    } as const;

    expect(renderSubsonicResponse(payload, "xml").status).toBe(200);
    expect(renderSubsonicResponse(payload, "xml", 501).status).toBe(501);
    expect(renderSubsonicResponse(payload, "json", 501).status).toBe(501);
  });

  it("keeps the envelope intact when a custom status is used", async () => {
    const xml = await renderSubsonicResponse(
      { status: "failed", error: new SubsonicError(SubsonicErrorCode.Generic, "not implemented") },
      "xml",
      501,
    ).text();

    expect(xml).toContain('status="failed"');
    expect(xml).toContain('<error code="0" message="not implemented"/>');
  });

  it("declares application/xml", () => {
    const response = renderSubsonicResponse({ status: "ok", body: {} }, "xml");

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/xml; charset=utf-8");
  });

  it("renders scalars as attributes and objects as child elements", async () => {
    const xml = await renderOk({ license: { valid: true, trialExpires: 0, email: "a@b.c" } });

    expect(xml).toContain('<license valid="true" trialExpires="0" email="a@b.c"/>');
  });

  it("repeats an element per array item", async () => {
    const xml = await renderOk({
      openSubsonicExtensions: [{ name: "formPost", versions: [1, 2] }],
    });

    expect(xml).toContain(
      '<openSubsonicExtensions name="formPost"><versions>1</versions><versions>2</versions>' +
        "</openSubsonicExtensions>",
    );
  });

  it("omits undefined properties", async () => {
    const xml = await renderOk({ user: { username: "admin", email: undefined } });

    expect(xml).toContain('<user username="admin"/>');
  });

  it("escapes & < > \" and ' in attribute values", async () => {
    const xml = await renderOk({ track: { title: `Tom & <Jerry> "quoted" 'single'` } });

    expect(xml).toContain(
      '<track title="Tom &amp; &lt;Jerry&gt; &quot;quoted&quot; &apos;single&apos;"/>',
    );
  });

  it("escapes & < > in element text", async () => {
    const xml = await renderOk({ note: ["a & b < c > d"] });

    expect(xml).toContain("<note>a &amp; b &lt; c &gt; d</note>");
  });

  it("renders a failure as status=failed with an error child", async () => {
    const xml = await renderFailed(
      new SubsonicError(SubsonicErrorCode.AuthenticationFailed, 'Wrong "password"'),
    );

    expect(xml).toContain('status="failed"');
    expect(xml).toContain('<error code="40" message="Wrong &quot;password&quot;"/>');
  });

  it("uses the Subsonic default message when none is given", async () => {
    const xml = await renderFailed(new SubsonicError(SubsonicErrorCode.MissingParameter));

    expect(xml).toContain('<error code="10" message="Required parameter is missing"/>');
  });
});

describe("JSON rendering", () => {
  it("wraps the envelope under subsonic-response", async () => {
    const json = JSON.parse(await renderOk({}, "json"));

    expect(json).toEqual({
      "subsonic-response": {
        status: "ok",
        version: "1.16.1",
        type: "stratosonic",
        serverVersion: SERVER_VERSION,
        openSubsonic: true,
      },
    });
  });

  it("declares application/json", () => {
    const response = renderSubsonicResponse({ status: "ok", body: {} }, "json");

    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
  });

  it("keeps arrays and nested objects as JSON, unescaped", async () => {
    const json = JSON.parse(
      await renderOk({ openSubsonicExtensions: [{ name: "form&Post", versions: [1] }] }, "json"),
    );

    expect(json["subsonic-response"].openSubsonicExtensions).toEqual([
      { name: "form&Post", versions: [1] },
    ]);
  });

  it("renders a failure as an error object", async () => {
    const json = JSON.parse(
      await renderFailed(new SubsonicError(SubsonicErrorCode.NotFound, "view not found"), "json"),
    );

    expect(json["subsonic-response"].status).toBe("failed");
    expect(json["subsonic-response"].error).toEqual({ code: 70, message: "view not found" });
  });
});
