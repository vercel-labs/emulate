package auth

import (
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
)

func TestParseSigV4Header(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "https://sqs.us-west-2.amazonaws.com/", nil)
	req.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/20260519/us-west-2/sqs/aws4_request, SignedHeaders=host;x-amz-date, Signature=abcdef")
	req.Header.Set("X-Amz-Security-Token", "token-123")

	signature, err := ParseSigV4(req)
	if err != nil {
		t.Fatal(err)
	}

	if !signature.Present {
		t.Fatal("signature should be present")
	}
	if signature.AccessKeyID != "AKIAEXAMPLE" {
		t.Fatalf("access key = %q, want AKIAEXAMPLE", signature.AccessKeyID)
	}
	if signature.Scope.Region != "us-west-2" || signature.Scope.Service != "sqs" {
		t.Fatalf("scope = %#v, want us-west-2/sqs", signature.Scope)
	}
	if !reflect.DeepEqual(signature.SignedHeaders, []string{"host", "x-amz-date"}) {
		t.Fatalf("signed headers = %#v", signature.SignedHeaders)
	}
	if signature.SignatureValue != "abcdef" || signature.SessionToken != "token-123" {
		t.Fatalf("unexpected signature fields: %#v", signature)
	}
}

func TestParseSigV4PresignedURL(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "https://s3.us-east-1.amazonaws.com/photos?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAPRE%2F20260519%2Feu-central-1%2Fs3%2Faws4_request&X-Amz-SignedHeaders=host&X-Amz-Signature=123456", nil)

	signature, err := ParseSigV4(req)
	if err != nil {
		t.Fatal(err)
	}

	if !signature.Presigned {
		t.Fatal("signature should be marked as presigned")
	}
	if signature.AccessKeyID != "AKIAPRE" || signature.Scope.Region != "eu-central-1" || signature.Scope.Service != "s3" {
		t.Fatalf("unexpected signature: %#v", signature)
	}
}

func TestResolveRelaxedAllowsUnknownKey(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "https://sts.amazonaws.com/", nil)
	req.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential=AKIAUNKNOWN/20260519/us-east-2/sts/aws4_request, SignedHeaders=host, Signature=abcdef")

	ctx := Resolve(req, Options{Mode: ModeRelaxed})

	if ctx.Status != StatusRelaxed {
		t.Fatalf("status = %q, want %q", ctx.Status, StatusRelaxed)
	}
	if ctx.Error != nil {
		t.Fatalf("error = %#v, want nil", ctx.Error)
	}
	if ctx.AccountID != DefaultAccountID {
		t.Fatalf("account id = %q, want %q", ctx.AccountID, DefaultAccountID)
	}
}

func TestResolveKnownKeysUsesCredentialIdentity(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "https://sts.amazonaws.com/", nil)
	req.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential=AKIAKNOWN/20260519/us-east-1/sts/aws4_request, SignedHeaders=host, Signature=abcdef")
	store := NewStore(Credential{
		AccessKeyID:     "AKIAKNOWN",
		SecretAccessKey: "secret",
		AccountID:       "210987654321",
		PrincipalARN:    "arn:aws:iam::210987654321:user/tester",
	})

	ctx := Resolve(req, Options{Mode: ModeKnownKeys, Store: store})

	if ctx.Status != StatusKnown {
		t.Fatalf("status = %q, want %q", ctx.Status, StatusKnown)
	}
	if ctx.AccountID != "210987654321" {
		t.Fatalf("account id = %q, want 210987654321", ctx.AccountID)
	}
	if ctx.PrincipalARN != "arn:aws:iam::210987654321:user/tester" {
		t.Fatalf("principal ARN = %q", ctx.PrincipalARN)
	}
}

func TestResolveKnownKeysRequiresStoredSessionToken(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "https://sts.amazonaws.com/", nil)
	req.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential=AKIATEMP/20260519/us-east-1/sts/aws4_request, SignedHeaders=host, Signature=abcdef")
	store := NewStore(Credential{
		AccessKeyID:  "AKIATEMP",
		SessionToken: "session-123",
	})

	ctx := Resolve(req, Options{Mode: ModeKnownKeys, Store: store})

	if ctx.Status != StatusInvalid {
		t.Fatalf("status = %q, want %q", ctx.Status, StatusInvalid)
	}
	if ctx.Error == nil || ctx.Error.Code != "InvalidToken" {
		t.Fatalf("error = %#v, want InvalidToken", ctx.Error)
	}
}

func TestResolveKnownKeysAcceptsStoredSessionToken(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "https://sts.amazonaws.com/", nil)
	req.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential=AKIATEMP/20260519/us-east-1/sts/aws4_request, SignedHeaders=host, Signature=abcdef")
	req.Header.Set("X-Amz-Security-Token", "session-123")
	store := NewStore(Credential{
		AccessKeyID:  "AKIATEMP",
		SessionToken: "session-123",
	})

	ctx := Resolve(req, Options{Mode: ModeKnownKeys, Store: store})

	if ctx.Status != StatusKnown {
		t.Fatalf("status = %q, want %q", ctx.Status, StatusKnown)
	}
	if ctx.Error != nil {
		t.Fatalf("error = %#v, want nil", ctx.Error)
	}
}

func TestResolveKnownKeysUnknownKeyIsExplicit(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "https://sts.amazonaws.com/", nil)
	req.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential=AKIAMISSING/20260519/us-east-1/sts/aws4_request, SignedHeaders=host, Signature=abcdef")

	ctx := Resolve(req, Options{Mode: ModeKnownKeys, Store: NewStore()})

	if ctx.Status != StatusUnknownKey {
		t.Fatalf("status = %q, want %q", ctx.Status, StatusUnknownKey)
	}
	if ctx.Error == nil || ctx.Error.Code != "InvalidAccessKeyId" {
		t.Fatalf("error = %#v, want InvalidAccessKeyId", ctx.Error)
	}
}

func TestResolveKnownKeysMissingAuthIsExplicit(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "https://sts.amazonaws.com/", nil)

	ctx := Resolve(req, Options{Mode: ModeKnownKeys})

	if ctx.Status != StatusMissing {
		t.Fatalf("status = %q, want %q", ctx.Status, StatusMissing)
	}
	if ctx.Error == nil || ctx.Error.Code != "MissingAuthenticationToken" {
		t.Fatalf("error = %#v, want MissingAuthenticationToken", ctx.Error)
	}
}

func TestResolveKnownKeysRejectsBareCredentialScope(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "https://sts.amazonaws.com/", nil)
	req.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential=AKIAKNOWN, SignedHeaders=host, Signature=abcdef")
	store := NewStore(Credential{AccessKeyID: "AKIAKNOWN"})

	ctx := Resolve(req, Options{Mode: ModeKnownKeys, Store: store})

	if ctx.Status != StatusInvalid {
		t.Fatalf("status = %q, want %q", ctx.Status, StatusInvalid)
	}
	if ctx.Error == nil || ctx.Error.Code != "AuthorizationHeaderMalformed" {
		t.Fatalf("error = %#v, want AuthorizationHeaderMalformed", ctx.Error)
	}
}

func TestResolveInvalidModeIsExplicit(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "https://sts.amazonaws.com/", nil)
	req.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential=AKIAKNOWN/20260519/us-east-1/sts/aws4_request, SignedHeaders=host, Signature=abcdef")
	store := NewStore(Credential{AccessKeyID: "AKIAKNOWN"})

	ctx := Resolve(req, Options{Mode: Mode("typo"), Store: store})

	if ctx.Mode != Mode("typo") {
		t.Fatalf("mode = %q, want typo", ctx.Mode)
	}
	if ctx.Status != StatusInvalid {
		t.Fatalf("status = %q, want %q", ctx.Status, StatusInvalid)
	}
	if ctx.Error == nil || ctx.Error.Code != "InvalidAuthMode" {
		t.Fatalf("error = %#v, want InvalidAuthMode", ctx.Error)
	}
}

func TestResolveStrictDoesNotRequireSignatureValidationYet(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "https://sts.amazonaws.com/", nil)
	req.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential=AKIASTRICT/20260519/us-east-1/sts/aws4_request, SignedHeaders=host, Signature=not-checked")
	store := NewStore(Credential{AccessKeyID: "AKIASTRICT"})

	ctx := Resolve(req, Options{Mode: ModeStrict, Store: store})

	if ctx.Status != StatusKnown {
		t.Fatalf("status = %q, want %q", ctx.Status, StatusKnown)
	}
	if ctx.Error != nil {
		t.Fatalf("error = %#v, want nil", ctx.Error)
	}
	if ctx.StrictSignatureValidation {
		t.Fatal("strict mode should not require cryptographic validation yet")
	}
}
