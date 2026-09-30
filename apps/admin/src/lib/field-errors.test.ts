import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api";
import {
  fieldErrorsFrom,
  NO_FIELD_ERRORS,
  stillCurrent,
  withoutFieldError,
} from "@/lib/field-errors";

const FIELDS_BY_CODE = { wrong_password: "current-password" };

function formData(values: Record<string, string>): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries(values)) {
    form.set(name, value);
  }
  return form;
}

describe("fieldErrorsFrom", () => {
  it("puts a refusal a field owns beside that field, in words", () => {
    expect(
      fieldErrorsFrom(new ApiError(400, "wrong_password", "wrong_password"), FIELDS_BY_CODE),
    ).toEqual({ "current-password": "The current password is wrong." });
  });

  it("leaves any other failure to a toast", () => {
    expect(fieldErrorsFrom(new ApiError(429, "rate_limited", ""), FIELDS_BY_CODE)).toBeUndefined();
    expect(fieldErrorsFrom(new ApiError(0, "network", ""), FIELDS_BY_CODE)).toBeUndefined();
    expect(fieldErrorsFrom(new Error("wrong_password"), FIELDS_BY_CODE)).toBeUndefined();
    expect(fieldErrorsFrom(undefined, FIELDS_BY_CODE)).toBeUndefined();
  });

  it("takes only the codes it was given, not the object's own keys", () => {
    expect(fieldErrorsFrom(new ApiError(400, "toString", ""), FIELDS_BY_CODE)).toBeUndefined();
  });
});

describe("withoutFieldError", () => {
  const errors = { "current-password": "The current password is wrong.", other: "Other." };

  it("drops the error of the field that changed, and only that one", () => {
    expect(withoutFieldError(errors, "current-password")).toEqual({ other: "Other." });
    expect(errors).toHaveProperty("current-password");
  });

  it("answers the same object when that field has no error", () => {
    expect(withoutFieldError(errors, "confirm")).toBe(errors);
    expect(withoutFieldError(NO_FIELD_ERRORS, "current-password")).toBe(NO_FIELD_ERRORS);
  });
});

describe("stillCurrent", () => {
  const errors = { "current-password": "The current password is wrong." };
  const sent = formData({ "current-password": "sesame", confirm: "a" });

  it("keeps an error whose field still holds the value sent", () => {
    expect(
      stillCurrent(errors, sent, formData({ "current-password": "sesame", confirm: "b" })),
    ).toEqual(errors);
  });

  it("drops an error whose field was edited while the request was out", () => {
    expect(stillCurrent(errors, sent, formData({ "current-password": "sesame!" }))).toEqual({});
    expect(stillCurrent(errors, sent, formData({}))).toEqual({});
  });
});
