import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import * as HttpClientError from "effect/http/HttpClientError"
import { classifyConnectionFailure, ConnectionEndpointError, ConnectionLifecycle } from "../src/main/ConnectionLifecycle"

const request = {} as HttpClientError.HttpClientError["request"]
const response = (status: number) => ({ status } as HttpClientError.StatusCodeError["response"])

const statusFailure = (status: number) => new HttpClientError.HttpClientError({
  reason: new HttpClientError.StatusCodeError({ request, response: response(status) })
})

const transportFailure = (code: string, message: string) => new HttpClientError.HttpClientError({
  reason: new HttpClientError.TransportError({
    request,
    cause: Object.assign(new Error(message), { code })
  })
})

const decodeFailure = (status: number) => new HttpClientError.HttpClientError({
  reason: new HttpClientError.DecodeError({ request, response: response(status) })
})

describe("remote connection endpoint validation", () => {
  it("accepts HTTPS origins and removes repeated trailing slashes", () => {
    expect(ConnectionLifecycle.validateRemoteEndpoint("https://library.example.test/"))
      .toBe("https://library.example.test")
    expect(ConnectionLifecycle.validateRemoteEndpoint("https://library.example.test/henshin///"))
      .toBe("https://library.example.test/henshin")
  })

  it.each([
    "http://library.example.test",
    "https://user:password@library.example.test",
    "https://library.example.test/?redirect=other",
    "https://library.example.test/#fragment",
    "https://library.example.test/?",
    "https://library.example.test/#"
  ])("rejects an unsafe endpoint: %s", (endpoint) => {
    expect(() => ConnectionLifecycle.validateRemoteEndpoint(endpoint)).toThrow(ConnectionEndpointError)
  })
})

describe("remote connection failure diagnostics", () => {
  it.each([
    ["CERT_HAS_EXPIRED", "certificate has expired", "connection_tls_expired", "Renew the certificate on the server"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "Hostname/IP does not match certificate's altnames", "connection_tls_hostname", "Use the hostname covered by the certificate"],
    ["SELF_SIGNED_CERT_IN_CHAIN", "self-signed certificate in certificate chain", "connection_tls_untrusted", "NODE_EXTRA_CA_CERTS"],
  ] as const)("distinguishes Node TLS failure %s", (code, detail, expectedCode, expectedMessage) => {
    const actual = classifyConnectionFailure(transportFailure(code, detail))
    expect(actual.code).toBe(expectedCode)
    expect(actual.message).toContain(expectedMessage)
    expect(actual.retryable).toBe(false)
  })

  it.each([
    [404, "connection_endpoint_failed", false, "Henshin HTTPS endpoint"],
    [500, "connection_server_failed", true, "server health and logs"],
  ] as const)("distinguishes HTTP %s from reachability", (status, expectedCode, retryable, expectedMessage) => {
    const failure = classifyConnectionFailure(statusFailure(status))
    expect(failure).toMatchObject({ code: expectedCode, retryable })
    expect(failure.message).toContain(expectedMessage)
  })

  it("reports an invalid handshake response separately from reachability", () => {
    const failure = classifyConnectionFailure(decodeFailure(200))
    expect(failure).toMatchObject({ code: "connection_response_invalid", retryable: false })
    expect(failure.message).toContain("compatible Henshin server")
  })

  it("keeps a TLS handshake timeout retryable instead of calling it an untrusted certificate", () => {
    const failure = classifyConnectionFailure(transportFailure("ERR_TLS_HANDSHAKE_TIMEOUT", "TLS handshake timeout"))
    expect(failure).toMatchObject({ code: "connection_failed", retryable: true })
  })

  it("uses the response status when the API client reports an unknown status as a decode failure", () => {
    expect(classifyConnectionFailure(decodeFailure(404)).code).toBe("connection_endpoint_failed")
    expect(classifyConnectionFailure(decodeFailure(503)).code).toBe("connection_server_failed")
    expect(classifyConnectionFailure(decodeFailure(302)).code).toBe("connection_redirect_refused")
  })

  it("reports the API client's schema decode failure as an invalid response", () => {
    let error: unknown
    try {
      Schema.decodeUnknownSync(Schema.Struct({ expected: Schema.String }))({})
    } catch (caught) {
      error = caught
    }
    expect(Schema.isSchemaError(error)).toBe(true)
    expect(classifyConnectionFailure(error)).toMatchObject({ code: "connection_response_invalid", retryable: false })
  })
})
