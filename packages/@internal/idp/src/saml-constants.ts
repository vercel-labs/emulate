export const ENTRA_ID_ATTRIBUTE_MAPPINGS: Record<string, string> = {
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier": "uid",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress": "email",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name": "name",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname": "given_name",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname": "family_name",
};

export const SAML_NAMEID_FORMATS: Record<string, string> = {
  emailAddress: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
  persistent: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
  unspecified: "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified",
};

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
