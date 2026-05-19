package auth

import (
	"fmt"
	"net/http"
)

const DefaultAccountID = "123456789012"

type Status string

const (
	StatusMissing    Status = "missing"
	StatusRelaxed    Status = "relaxed"
	StatusKnown      Status = "known"
	StatusUnknownKey Status = "unknown_key"
	StatusInvalid    Status = "invalid"
)

type Error struct {
	Code       string
	Message    string
	StatusCode int
}

type Context struct {
	Mode                      Mode
	Status                    Status
	Signature                 Signature
	Credential                *Credential
	AccountID                 string
	PrincipalARN              string
	Error                     *Error
	StrictSignatureValidation bool
}

type Options struct {
	Mode                Mode
	Store               *Store
	DefaultAccountID    string
	DefaultPrincipalARN string
}

func Resolve(req *http.Request, options Options) Context {
	mode := NormalizeMode(options.Mode)
	accountID := firstNonEmpty(options.DefaultAccountID, DefaultAccountID)
	ctx := Context{
		Mode:                      mode,
		AccountID:                 accountID,
		PrincipalARN:              firstNonEmpty(options.DefaultPrincipalARN, defaultPrincipalARN(accountID)),
		StrictSignatureValidation: false,
	}

	signature, err := ParseSigV4(req)
	if err != nil {
		ctx.Status = StatusInvalid
		ctx.Error = &Error{
			Code:       "AuthorizationHeaderMalformed",
			Message:    err.Error(),
			StatusCode: http.StatusBadRequest,
		}
		return ctx
	}
	ctx.Signature = signature
	if !signature.Present {
		ctx.Status = StatusMissing
		if mode != ModeRelaxed {
			ctx.Error = &Error{
				Code:       "MissingAuthenticationToken",
				Message:    "Request is missing AWS authentication credentials.",
				StatusCode: http.StatusForbidden,
			}
		}
		return ctx
	}

	if credential, ok := options.Store.Resolve(signature.AccessKeyID); ok {
		ctx.Status = StatusKnown
		ctx.Credential = &credential
		ctx.AccountID = firstNonEmpty(credential.AccountID, ctx.AccountID)
		ctx.PrincipalARN = firstNonEmpty(credential.PrincipalARN, defaultPrincipalARN(ctx.AccountID))
		return ctx
	}

	if mode == ModeRelaxed {
		ctx.Status = StatusRelaxed
		return ctx
	}

	ctx.Status = StatusUnknownKey
	ctx.Error = &Error{
		Code:       "InvalidAccessKeyId",
		Message:    "The AWS access key Id you provided does not exist in our records.",
		StatusCode: http.StatusForbidden,
	}
	return ctx
}

func defaultPrincipalARN(accountID string) string {
	return fmt.Sprintf("arn:aws:iam::%s:user/emulate", accountID)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
