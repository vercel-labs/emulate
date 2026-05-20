package microsoft

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

const keyID = "emulate-microsoft-1"

var signer = mustJWTSigner()

type jwtSigner struct {
	privateKey *rsa.PrivateKey
}

func mustJWTSigner() *jwtSigner {
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
				"kid": keyID,
				"alg": "RS256",
				"n":   base64.RawURLEncoding.EncodeToString(publicKey.N.Bytes()),
				"e":   base64.RawURLEncoding.EncodeToString(big.NewInt(int64(publicKey.E)).Bytes()),
			},
		},
	}
}

func createIDToken(user corestore.Record, clientID string, nonce string, baseURL string) (string, error) {
	now := time.Now().Unix()
	tenantID := stringField(user, "tenant_id")
	if tenantID == "" {
		tenantID = defaultTenantID
	}
	claims := map[string]any{
		"iss":                baseURL + "/" + tenantID + "/v2.0",
		"aud":                clientID,
		"sub":                stringField(user, "oid"),
		"email":              stringField(user, "email"),
		"name":               stringField(user, "name"),
		"given_name":         stringField(user, "given_name"),
		"family_name":        stringField(user, "family_name"),
		"preferred_username": stringField(user, "preferred_username"),
		"oid":                stringField(user, "oid"),
		"tid":                tenantID,
		"ver":                "2.0",
		"iat":                now,
		"exp":                now + 3600,
	}
	if nonce != "" {
		claims["nonce"] = nonce
	}
	return signer.sign(claims)
}

func (s *jwtSigner) sign(claims map[string]any) (string, error) {
	header := map[string]any{"alg": "RS256", "kid": keyID, "typ": "JWT"}
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
