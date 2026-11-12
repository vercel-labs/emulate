export const SAML_NAMEID_FORMATS = {
  emailAddress: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
  persistent: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
  transient: "urn:oasis:names:tc:SAML:2.0:nameid-format:transient",
  unspecified: "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified",
  x509SubjectName: "urn:oasis:names:tc:SAML:1.1:nameid-format:x509SubjectName",
} as const;

export const SAML_BINDINGS = {
  HTTP_REDIRECT: "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect",
  HTTP_POST: "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST",
} as const;

export const SAML_NS = {
  PROTOCOL: "urn:oasis:names:tc:SAML:2.0:protocol",
  ASSERTION: "urn:oasis:names:tc:SAML:2.0:assertion",
  METADATA: "urn:oasis:names:tc:SAML:2.0:metadata",
  XMLDSIG: "http://www.w3.org/2000/09/xmldsig#",
} as const;

export const SAML_SIGNATURE_ALGORITHMS = {
  RSA_SHA256: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
  RSA_SHA1: "http://www.w3.org/2000/09/xmldsig#rsa-sha1",
} as const;

export const SAML_DIGEST_ALGORITHMS = {
  SHA256: "http://www.w3.org/2001/04/xmlenc#sha256",
  SHA1: "http://www.w3.org/2000/09/xmldsig#sha1",
} as const;

export const SAML_AUTHN_CONTEXT_PASSWORD_PROTECTED_TRANSPORT =
  "urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport";
