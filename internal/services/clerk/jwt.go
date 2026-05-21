package clerk

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"time"

	corestore "github.com/vercel-labs/emulate/internal/core/store"
)

const clerkKeyID = "emulate-clerk-1"

var clerkSigner = mustClerkJWTSigner()

type jwtSigner struct {
	privateKey *rsa.PrivateKey
}

func mustClerkJWTSigner() *jwtSigner {
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		panic(err)
	}
	return &jwtSigner{privateKey: privateKey}
}

func (s *jwtSigner) jwks() map[string]any {
	publicKey := s.privateKey.Public().(*rsa.PublicKey)
	return map[string]any{
		"keys": []map[string]any{
			{
				"kty": "RSA",
				"use": "sig",
				"kid": clerkKeyID,
				"alg": "RS256",
				"n":   base64.RawURLEncoding.EncodeToString(publicKey.N.Bytes()),
				"e":   base64.RawURLEncoding.EncodeToString(big.NewInt(int64(publicKey.E)).Bytes()),
			},
		},
	}
}

func createIDToken(user corestore.Record, emails []corestore.Record, sessionID string, clientID string, issuer string, nonce string) (string, error) {
	now := time.Now().Unix()
	primary := primaryEmail(emails)
	claims := map[string]any{
		"iss": issuer,
		"sub": stringField(user, "clerk_id"),
		"aud": firstNonEmpty(clientID, "default"),
		"iat": now,
		"exp": now + 3600,
		"sid": sessionID,
	}
	if primary != nil {
		claims["email"] = stringField(primary, "email_address")
		claims["email_verified"] = stringField(primary, "verification_status") == "verified"
	}
	if name := userDisplayName(user); name != "" {
		claims["name"] = name
	}
	if nonce != "" {
		claims["nonce"] = nonce
	}
	return clerkSigner.sign(claims)
}

func createSessionToken(user corestore.Record, sessionID string, issuer string, org corestore.Record, membership corestore.Record) (string, error) {
	now := time.Now().Unix()
	claims := map[string]any{
		"iss": issuer,
		"sub": stringField(user, "clerk_id"),
		"iat": now,
		"nbf": now,
		"exp": now + 3600,
		"sid": sessionID,
	}
	if org != nil && membership != nil {
		claims["org_id"] = stringField(org, "clerk_id")
		claims["org_role"] = firstNonEmpty(stringField(membership, "role"), "org:member")
		claims["org_slug"] = stringField(org, "slug")
		claims["org_permissions"] = stringSliceValue(membership["permissions"])
	}
	metadata := mapValue(user["public_metadata"])
	if len(metadata) > 0 {
		claims["metadata"] = metadata
	}
	return clerkSigner.sign(claims)
}

func (s *jwtSigner) sign(claims map[string]any) (string, error) {
	header := map[string]any{"alg": "RS256", "kid": clerkKeyID, "typ": "JWT"}
	headerJSON, err := json.Marshal(header)
	if err != nil {
		return "", err
	}
	claimsJSON, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	signingInput := base64.RawURLEncoding.EncodeToString(headerJSON) + "." + base64.RawURLEncoding.EncodeToString(claimsJSON)
	digest := sha256.Sum256([]byte(signingInput))
	signature, err := rsa.SignPKCS1v15(rand.Reader, s.privateKey, crypto.SHA256, digest[:])
	if err != nil {
		return "", err
	}
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(signature), nil
}

func primaryEmail(emails []corestore.Record) corestore.Record {
	for _, email := range emails {
		if boolField(email, "is_primary") {
			return email
		}
	}
	return firstRecord(emails)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
