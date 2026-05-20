package google

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"time"
)

const googleKeyID = "emulate-google-1"

var googleSigner = mustGoogleJWTSigner()

type googleJWTSigner struct {
	privateKey *rsa.PrivateKey
}

func mustGoogleJWTSigner() *googleJWTSigner {
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		panic(err)
	}
	return &googleJWTSigner{privateKey: privateKey}
}

func (s *googleJWTSigner) jwks() map[string]any {
	publicKey := s.privateKey.Public().(*rsa.PublicKey)
	return map[string]any{
		"keys": []map[string]any{
			{
				"kty": "RSA",
				"use": "sig",
				"kid": googleKeyID,
				"alg": "RS256",
				"n":   base64.RawURLEncoding.EncodeToString(publicKey.N.Bytes()),
				"e":   base64.RawURLEncoding.EncodeToString(big.NewInt(int64(publicKey.E)).Bytes()),
			},
		},
	}
}

func signIDToken(user map[string]any, clientID string, nonce string, issuer string) (string, error) {
	now := time.Now().Unix()
	claims := map[string]any{
		"iss":            issuer,
		"aud":            clientID,
		"sub":            stringValue(user["uid"]),
		"email":          stringValue(user["email"]),
		"email_verified": user["email_verified"],
		"name":           stringValue(user["name"]),
		"given_name":     stringValue(user["given_name"]),
		"family_name":    stringValue(user["family_name"]),
		"picture":        user["picture"],
		"locale":         stringValue(user["locale"]),
		"iat":            now,
		"exp":            now + 3600,
	}
	if hd := stringValue(user["hd"]); hd != "" {
		claims["hd"] = hd
	}
	if nonce != "" {
		claims["nonce"] = nonce
	}
	return googleSigner.sign(claims)
}

func (s *googleJWTSigner) sign(claims map[string]any) (string, error) {
	header := map[string]any{"alg": "RS256", "kid": googleKeyID, "typ": "JWT"}
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
