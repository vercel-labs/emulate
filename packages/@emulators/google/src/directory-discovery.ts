// A subset of Google's Admin SDK Directory API discovery document (revision 20261111): the methods,
// parameters and resource fields this emulator implements, as Google publishes them.
const document = {
  kind: "discovery#restDescription",
  discoveryVersion: "v1",
  id: "admin:directory_v1",
  name: "admin",
  canonicalName: "directory",
  version: "directory_v1",
  revision: "20261111",
  title: "Admin SDK API",
  description:
    "Admin SDK lets administrators of enterprise domains to view and manage resources like user, groups etc. It also provides audit and usage reports of domain.",
  ownerDomain: "google.com",
  ownerName: "Google",
  documentationLink: "https://developers.google.com/workspace/admin/",
  protocol: "rest",
  parameters: {
    uploadType: {
      location: "query",
      description: 'Legacy upload protocol for media (e.g. "media", "multipart").',
      type: "string",
    },
    prettyPrint: {
      type: "boolean",
      description: "Returns response with indentations and line breaks.",
      location: "query",
      default: "true",
    },
    quotaUser: {
      location: "query",
      type: "string",
      description:
        "Available to use for quota purposes for server-side applications. Can be any arbitrary string assigned to a user, but should not exceed 40 characters.",
    },
    oauth_token: {
      location: "query",
      description: "OAuth 2.0 token for the current user.",
      type: "string",
    },
    fields: {
      type: "string",
      description: "Selector specifying which fields to include in a partial response.",
      location: "query",
    },
    alt: {
      default: "json",
      enumDescriptions: [
        "Responses with Content-Type of application/json",
        "Media download with context-dependent Content-Type",
        "Responses with Content-Type of application/x-protobuf",
      ],
      description: "Data format for response.",
      type: "string",
      enum: ["json", "media", "proto"],
      location: "query",
    },
    upload_protocol: {
      type: "string",
      description: 'Upload protocol for media (e.g. "raw", "multipart").',
      location: "query",
    },
    access_token: {
      type: "string",
      location: "query",
      description: "OAuth access token.",
    },
    "$.xgafv": {
      enum: ["1", "2"],
      enumDescriptions: ["v1 error format", "v2 error format"],
      type: "string",
      description: "V1 error format.",
      location: "query",
    },
    key: {
      type: "string",
      location: "query",
      description:
        "API key. Your API key identifies your project and provides you with API access, quota, and reports. Required unless you provide an OAuth 2.0 token.",
    },
    callback: {
      description: "JSONP",
      location: "query",
      type: "string",
    },
  },
  auth: {
    oauth2: {
      scopes: {
        "https://www.googleapis.com/auth/admin.directory.group": {
          description: "View and manage the provisioning of groups on your domain",
        },
        "https://www.googleapis.com/auth/admin.directory.group.member": {
          description: "View and manage group subscriptions on your domain",
        },
        "https://www.googleapis.com/auth/admin.directory.group.member.readonly": {
          description: "View group subscriptions on your domain",
        },
        "https://www.googleapis.com/auth/admin.directory.group.readonly": {
          description: "View groups on your domain",
        },
        "https://www.googleapis.com/auth/admin.directory.user": {
          description: "View and manage the provisioning of users on your domain",
        },
        "https://www.googleapis.com/auth/admin.directory.user.readonly": {
          description: "See info about users on your domain",
        },
        "https://www.googleapis.com/auth/cloud-platform": {
          description:
            "See, edit, configure, and delete your Google Cloud data and see the email address for your Google Account.",
        },
      },
    },
  },
  schemas: {
    User: {
      properties: {
        kind: {
          type: "string",
          readOnly: true,
          default: "admin#directory#user",
          description:
            "Output only. The type of the API resource. For Users resources, the value is `admin#directory#user`.",
        },
        id: {
          description: "The unique ID for the user. A user `id` can be used as a user request URI's `userKey`.",
          type: "string",
        },
        etag: {
          readOnly: true,
          type: "string",
          description: "Output only. ETag of the resource.",
        },
        primaryEmail: {
          annotations: {
            required: ["directory.users.insert"],
          },
          description:
            "The user's primary email address. This property is required in a request to create a user account. The `primaryEmail` must be unique and cannot be an alias of another user.",
          type: "string",
        },
        password: {
          type: "string",
          annotations: {
            required: ["directory.users.insert"],
          },
          description: "User's password",
        },
        hashFunction: {
          description:
            "Stores the hash format of the `password` property. The following `hashFunction` values are allowed: * `MD5` - Accepts simple hex-encoded values. * `SHA-1` - Accepts simple hex-encoded values. * `crypt` - Compliant with the [C crypt library](https://en.wikipedia.org/wiki/Crypt_%28C%29). Supports the DES, MD5 (hash prefix `$1$`), SHA-256 (hash prefix `$5$`), and SHA-512 (hash prefix `$6$`) hash algorithms. If rounds are specified as part of the prefix, they must be 10,000 or fewer.",
          type: "string",
        },
        name: {
          annotations: {
            required: ["directory.users.insert"],
          },
          $ref: "UserName",
          description:
            "Holds the given and family names of the user, and the read-only `fullName` value. The maximum number of characters in the `givenName` and in the `familyName` values is 60. In addition, name values support unicode/UTF-8 characters, and can contain spaces, letters (a-z), numbers (0-9), dashes (-), forward slashes (/), and periods (.). For more information about character usage rules, see the [administration help center](https://support.google.com/a/answer/9193374). Maximum allowed data size for this field is 1KB.",
        },
        isAdmin: {
          description:
            "Output only. Indicates a user with super administrator privileges. The `isAdmin` property can only be edited in the [Make a user an administrator](https://developers.google.com/workspace/admin/directory/v1/guides/manage-users.html#make_admin) operation ( [makeAdmin](https://developers.google.com/workspace/admin/directory/v1/reference/users/makeAdmin.html) method). If edited in the user [insert](https://developers.google.com/workspace/admin/directory/v1/reference/users/insert.html) or [update](https://developers.google.com/workspace/admin/directory/v1/reference/users/update.html) methods, the edit is ignored by the API service.",
          readOnly: true,
          type: "boolean",
        },
        isDelegatedAdmin: {
          type: "boolean",
          description:
            "Output only. Indicates if the user is a delegated administrator. Delegated administrators are supported by the API but cannot create or undelete users, or make users administrators. These requests are ignored by the API service. Roles and privileges for administrators are assigned using the [Admin console](https://support.google.com/a/answer/33325).",
          readOnly: true,
        },
        lastLoginTime: {
          readOnly: true,
          type: "string",
          description: "User's last login time. (Read-only)",
          format: "date-time",
        },
        creationTime: {
          readOnly: true,
          format: "date-time",
          description: "User's G Suite account creation time. (Read-only)",
          type: "string",
        },
        agreedToTerms: {
          type: "boolean",
          description:
            "Output only. This property is `true` if the user has completed an initial login and accepted the Terms of Service agreement.",
          readOnly: true,
        },
        suspended: {
          type: "boolean",
          description: "Indicates if user is suspended.",
        },
        suspensionReason: {
          type: "string",
          description:
            "Output only. Has the reason a user account is suspended either by the administrator or by Google at the time of suspension. The property is returned only if the `suspended` property is `true`.",
          readOnly: true,
        },
        archived: {
          description: "Indicates if user is archived.",
          type: "boolean",
        },
        changePasswordAtNextLogin: {
          description:
            "Indicates if the user is forced to change their password at next login. This setting doesn't apply when [the user signs in via a third-party identity provider](https://support.google.com/a/answer/60224).",
          type: "boolean",
        },
        ipWhitelisted: {
          type: "boolean",
          description:
            "If `true`, the user's IP address is subject to a deprecated IP address [`allowlist`](https://support.google.com/a/answer/60752) configuration.",
        },
        emails: {
          type: "any",
          description:
            "The list of the user's email addresses. The maximum allowed data size for this field is 10KB. This excludes `publicKeyEncryptionCertificates`.",
        },
        nonEditableAliases: {
          readOnly: true,
          description:
            "Output only. The list of the user's non-editable alias email addresses. These are typically outside the account's primary domain or sub-domain.",
          type: "array",
          items: {
            type: "string",
          },
        },
        customerId: {
          description:
            "Output only. The customer ID to [retrieve all account users](https://developers.google.com/workspace/admin/directory/v1/guides/manage-users.html#get_all_users). You can use the alias `my_customer` to represent your account's `customerId`. As a reseller administrator, you can use the resold customer account's `customerId`. To get a `customerId`, use the account's primary domain in the `domain` parameter of a [users.list](https://developers.google.com/workspace/admin/directory/v1/reference/users/list) request.",
          readOnly: true,
          type: "string",
        },
        orgUnitPath: {
          type: "string",
          description:
            "The full path of the parent organization associated with the user. If the parent organization is the top-level, it is represented as a forward slash (`/`).",
        },
        isMailboxSetup: {
          description:
            "Output only. Indicates if the user's Google mailbox is created. This property is only applicable if the user has been assigned a Gmail license.",
          readOnly: true,
          type: "boolean",
        },
        includeInGlobalAddressList: {
          description:
            "Indicates if the user's profile is visible in the Google Workspace global address list when the contact sharing feature is enabled for the domain. For more information about excluding user profiles, see the [administration help center](https://support.google.com/a/answer/1285988).",
          type: "boolean",
        },
        isEnrolledIn2Sv: {
          description: "Output only. Is enrolled in 2-step verification (Read-only)",
          type: "boolean",
          readOnly: true,
        },
        isEnforcedIn2Sv: {
          description: "Output only. Is 2-step verification enforced (Read-only)",
          type: "boolean",
          readOnly: true,
        },
      },
      description:
        "The Directory API allows you to create and manage your account's users, user aliases, and user Google profile photos. For more information about common tasks, see the [User Accounts Developer's Guide](https://developers.google.com/workspace/admin/directory/v1/guides/manage-users.html) and the [User Aliases Developer's Guide](https://developers.google.com/workspace/admin/directory/v1/guides/manage-user-aliases.html).",
      type: "object",
      id: "User",
    },
    UserMakeAdmin: {
      properties: {
        status: {
          type: "boolean",
          description: "Indicates the administrator status of the user.",
          annotations: { required: ["directory.users.makeAdmin"] },
        },
      },
      type: "object",
      id: "UserMakeAdmin",
    },
    UserName: {
      id: "UserName",
      type: "object",
      properties: {
        givenName: {
          description: "The user's first name. Required when creating a user account.",
          type: "string",
          annotations: {
            required: ["directory.users.insert"],
          },
        },
        familyName: {
          annotations: {
            required: ["directory.users.insert"],
          },
          description: "The user's last name. Required when creating a user account.",
          type: "string",
        },
        fullName: {
          description: "The user's full name formed by concatenating the first and last name values.",
          type: "string",
        },
        displayName: {
          type: "string",
          description: "The user's display name. Limit: 256 characters.",
        },
      },
    },
    Users: {
      type: "object",
      id: "Users",
      properties: {
        kind: {
          default: "admin#directory#users",
          description: "Kind of resource this is.",
          type: "string",
        },
        etag: {
          description: "ETag of the resource.",
          type: "string",
        },
        users: {
          type: "array",
          description: "A list of user objects.",
          items: {
            $ref: "User",
          },
        },
        nextPageToken: {
          description: "Token used to access next page of this result. The page token is only valid for three days.",
          type: "string",
        },
      },
    },
    Group: {
      description:
        "Google Groups provide your users the ability to send messages to groups of people using the group's email address. For more information about common tasks, see the [Developer's Guide](https://developers.google.com/workspace/admin/directory/v1/guides/manage-groups). For information about other types of groups, see the [Cloud Identity Groups API documentation](https://cloud.google.com/identity/docs/groups). Note: The user calling the API (or being impersonated by a service account) must have an assigned [role](https://developers.google.com/workspace/admin/directory/v1/guides/manage-roles) that includes Admin API Groups permissions, such as Super Admin or Groups Admin.",
      id: "Group",
      properties: {
        kind: {
          description: "The type of the API resource. For Groups resources, the value is `admin#directory#group`.",
          default: "admin#directory#group",
          type: "string",
        },
        id: {
          type: "string",
          description:
            "Read-only. The unique ID of a group. A group `id` can be used as a group request URI's `groupKey`.",
        },
        etag: {
          description: "ETag of the resource.",
          type: "string",
        },
        email: {
          type: "string",
          description:
            "The group's email address. If your account has multiple domains, select the appropriate domain for the email address. The `email` must be unique. This property is required when creating a group. Group email addresses are subject to the same character usage rules as usernames, see the [help center](https://support.google.com/a/answer/9193374) for details.",
          annotations: {
            required: ["directory.groups.insert"],
          },
        },
        name: {
          type: "string",
          description: "The group's display name.",
        },
        description: {
          description:
            "An extended description to help users determine the purpose of a group. For example, you can include information about who should join the group, the types of messages to send to the group, links to FAQs about the group, or related groups. Maximum length is `4,096` characters.",
          type: "string",
        },
        directMembersCount: {
          type: "string",
          description:
            "The number of users that are direct members of the group. If a group is a member (child) of this group (the parent), members of the child group are not counted in the `directMembersCount` property of the parent group.",
          format: "int64",
        },
        adminCreated: {
          description: "Read-only. Value is `true` if this group was created by an administrator rather than a user.",
          type: "boolean",
        },
        aliases: {
          type: "array",
          items: {
            type: "string",
          },
          description:
            "Read-only. The list of a group's alias email addresses. To add, update, or remove a group's aliases, use the `groups.aliases` methods. If edited in a group's POST or PUT request, the edit is ignored.",
        },
        nonEditableAliases: {
          description:
            "Read-only. The list of the group's non-editable alias email addresses that are outside of the account's primary domain or subdomains. These are functioning email addresses used by the group. This is a read-only property returned in the API's response for a group. If edited in a group's POST or PUT request, the edit is ignored.",
          type: "array",
          items: {
            type: "string",
          },
        },
      },
      type: "object",
    },
    Groups: {
      type: "object",
      properties: {
        kind: {
          default: "admin#directory#groups",
          description: "Kind of resource this is.",
          type: "string",
        },
        etag: {
          description: "ETag of the resource.",
          type: "string",
        },
        groups: {
          description: "A list of group objects.",
          type: "array",
          items: {
            $ref: "Group",
          },
        },
        nextPageToken: {
          type: "string",
          description: "Token used to access next page of this result.",
        },
      },
      id: "Groups",
    },
    Member: {
      id: "Member",
      properties: {
        kind: {
          type: "string",
          description: "The type of the API resource. For Members resources, the value is `admin#directory#member`.",
          default: "admin#directory#member",
        },
        etag: {
          description: "ETag of the resource.",
          type: "string",
        },
        id: {
          description:
            "The unique ID of the group member. A member `id` can be used as a member request URI's `memberKey`.",
          type: "string",
        },
        email: {
          description:
            "The member's email address. A member can be a user or another group. This property is required when adding a member to a group. The `email` must be unique and cannot be an alias of another group. If the email address is changed, the API automatically reflects the email address changes.",
          type: "string",
        },
        role: {
          description:
            "The member's role in a group. The API returns an error for cycles in group memberships. For example, if `group1` is a member of `group2`, `group2` cannot be a member of `group1`. For more information about a member's role, see the [administration help center](https://support.google.com/a/answer/167094).",
          type: "string",
        },
        type: {
          type: "string",
          description: "The type of group member.",
        },
        status: {
          type: "string",
          description: "Status of member (Immutable)",
        },
        delivery_settings: {
          type: "string",
          description:
            "Defines mail delivery preferences of member. This field is only supported by `insert`, `update`, and `get` methods.",
        },
      },
      description:
        "A Google Groups member can be a user or another group. This member can be inside or outside of your account's domains. For more information about common group member tasks, see the [Developer's Guide](https://developers.google.com/workspace/admin/directory/v1/guides/manage-group-members).",
      type: "object",
    },
    Members: {
      type: "object",
      properties: {
        kind: {
          default: "admin#directory#members",
          description: "Kind of resource this is.",
          type: "string",
        },
        etag: {
          description: "ETag of the resource.",
          type: "string",
        },
        members: {
          items: {
            $ref: "Member",
          },
          description: "A list of member objects.",
          type: "array",
        },
        nextPageToken: {
          description: "Token used to access next page of this result.",
          type: "string",
        },
      },
      id: "Members",
    },
    MembersHasMember: {
      description: "JSON template for Has Member response in Directory API.",
      properties: {
        isMember: {
          description:
            "Output only. Identifies whether the given user is a member of the group. Membership can be direct or nested.",
          readOnly: true,
          type: "boolean",
        },
      },
      id: "MembersHasMember",
      type: "object",
    },
  },
  resources: {
    users: {
      methods: {
        list: {
          parameters: {
            customer: {
              location: "query",
              type: "string",
              description:
                "The unique ID for the customer's Google Workspace account. In case of a multi-domain account, to fetch all users for a customer, use this field instead of `domain`. You can also use the `my_customer` alias to represent your account's `customerId`. The `customerId` is also returned as part of the [Users](https://developers.google.com/workspace/admin/directory/v1/reference/users) resource. You must provide either the `customer` or the `domain` parameter.",
            },
            pageToken: {
              type: "string",
              location: "query",
              description: "Token to specify next page in the list. The page token is only valid for three days.",
            },
            showDeleted: {
              type: "string",
              location: "query",
              description: "If set to `true`, retrieves the list of deleted users. (Default: `false`)",
            },
            viewType: {
              enum: ["admin_view", "domain_public"],
              location: "query",
              enumDescriptions: [
                "Results include both administrator-only and domain-public fields for the user.",
                "Results only include fields for the user that are publicly visible to other users in the domain.",
              ],
              type: "string",
              default: "admin_view",
              description:
                "Whether to fetch the administrator-only or domain-wide public view of the user. For more information, see [Retrieve a user as a non-administrator](https://developers.google.com/workspace/admin/directory/v1/guides/manage-users#retrieve_users_non_admin).",
            },
            orderBy: {
              enum: ["email", "familyName", "givenName"],
              location: "query",
              enumDescriptions: ["Primary email of the user.", "User's family name.", "User's given name."],
              type: "string",
              description: "Property to use for sorting results.",
            },
            projection: {
              enum: ["basic", "custom", "full"],
              default: "basic",
              type: "string",
              enumDescriptions: [
                "Do not include any custom fields for the user.",
                "Include custom fields from schemas requested in `customFieldMask`.",
                "Include all fields associated with this user.",
              ],
              location: "query",
              description: "What subset of fields to fetch for this user.",
            },
            event: {
              type: "string",
              location: "query",
              description: "Event on which subscription is intended (if subscribing)",
              enumDescriptions: [
                "User Created Event",
                "User Deleted Event",
                "User Admin Status Change Event",
                "User Undeleted Event",
                "User Updated Event",
              ],
              enum: ["add", "delete", "makeAdmin", "undelete", "update"],
            },
            sortOrder: {
              enumDescriptions: ["Ascending order.", "Descending order."],
              description: "Whether to return results in ascending or descending order, ignoring case.",
              enum: ["ASCENDING", "DESCENDING"],
              location: "query",
              type: "string",
            },
            query: {
              type: "string",
              location: "query",
              description:
                "Query string for searching user fields. For more information on constructing user queries, see [Search for Users](https://developers.google.com/workspace/admin/directory/v1/guides/search-users).",
            },
            customFieldMask: {
              location: "query",
              description:
                "A comma-separated list of schema names. All fields from these schemas are fetched. This should only be set when `projection=custom`.",
              type: "string",
            },
            maxResults: {
              location: "query",
              default: "100",
              maximum: "500",
              minimum: "1",
              format: "int32",
              type: "integer",
              description: "Maximum number of results to return.",
            },
            domain: {
              type: "string",
              description:
                "The domain name. Use this field to get users from only one domain. To return all domains for a customer account, use the `customer` query parameter instead. Either the `customer` or the `domain` parameter must be provided.",
              location: "query",
            },
          },
          description: "Retrieves a paginated list of either deleted users or all users in a domain.",
          httpMethod: "GET",
          id: "directory.users.list",
          flatPath: "admin/directory/v1/users",
          path: "admin/directory/v1/users",
          scopes: [
            "https://www.googleapis.com/auth/admin.directory.user",
            "https://www.googleapis.com/auth/admin.directory.user.readonly",
            "https://www.googleapis.com/auth/cloud-platform",
          ],
          response: {
            $ref: "Users",
          },
          parameterOrder: [],
        },
        get: {
          response: {
            $ref: "User",
          },
          id: "directory.users.get",
          description: "Retrieves a user.",
          flatPath: "admin/directory/v1/users/{userKey}",
          parameterOrder: ["userKey"],
          parameters: {
            projection: {
              location: "query",
              type: "string",
              enumDescriptions: [
                "Do not include any custom fields for the user.",
                "Include custom fields from schemas requested in `customFieldMask`.",
                "Include all fields associated with this user.",
              ],
              default: "basic",
              description: "What subset of fields to fetch for this user.",
              enum: ["basic", "custom", "full"],
            },
            userKey: {
              description:
                "Identifies the user in the API request. The value can be the user's primary email address, alias email address, or unique user ID.",
              location: "path",
              type: "string",
              required: true,
            },
            viewType: {
              enumDescriptions: [
                "Results include both administrator-only and domain-public fields for the user.",
                "Results only include fields for the user that are publicly visible to other users in the domain.",
              ],
              description:
                "Whether to fetch the administrator-only or domain-wide public view of the user. For more information, see [Retrieve a user as a non-administrator](https://developers.google.com/workspace/admin/directory/v1/guides/manage-users#retrieve_users_non_admin).",
              type: "string",
              location: "query",
              default: "admin_view",
              enum: ["admin_view", "domain_public"],
            },
            customFieldMask: {
              type: "string",
              description:
                "A comma-separated list of schema names. All fields from these schemas are fetched. This should only be set when `projection=custom`.",
              location: "query",
            },
          },
          path: "admin/directory/v1/users/{userKey}",
          httpMethod: "GET",
          scopes: [
            "https://www.googleapis.com/auth/admin.directory.user",
            "https://www.googleapis.com/auth/admin.directory.user.readonly",
          ],
        },
        insert: {
          parameters: {
            resolveConflictAccount: {
              location: "query",
              description:
                "Optional. Applies the option selected for [Find and add unmanaged users](https://knowledge.workspace.google.com/admin/users/find-and-add-unmanaged-users) to resolve conflicting accounts when set to `true`. Default: `false`",
              type: "boolean",
            },
          },
          request: {
            $ref: "User",
          },
          httpMethod: "POST",
          response: {
            $ref: "User",
          },
          id: "directory.users.insert",
          description:
            "Creates a user. Mutate calls immediately following user creation might sometimes fail as the user isn't fully created due to propagation delay in our backends. Check the error details for the \"User creation is not complete\" message to see if this is the case. Retrying the calls after some time can help in this case. If `resolve_conflict_account` is set to `true`, the option selected for [Find and add unmanaged users](https://knowledge.workspace.google.com/admin/users/find-and-add-unmanaged-users) will apply to resolve conflicting accounts: - A `200` response code indicates the user was created (or replaced an existing unmanaged personal account). - A `202` response code means that a conflicting unmanaged personal account exists and was invited to join the organization. - A `409` response code means that a conflicting account exists so the user wasn't created (e.g. based on the option selected to preserve the account, or if the email conflicts with an unmanaged work account or existing managed user). For details on resolving duplicate account errors, see [Resolve duplicate account errors](https://knowledge.workspace.google.com/p/duplicate-account-errors) and [Transfer unmanaged work accounts](https://knowledge.workspace.google.com/p/unmanaged-work-accounts).",
          path: "admin/directory/v1/users",
          parameterOrder: [],
          flatPath: "admin/directory/v1/users",
          scopes: ["https://www.googleapis.com/auth/admin.directory.user"],
        },
        update: {
          parameters: {
            userKey: {
              type: "string",
              required: true,
              description:
                "Identifies the user in the API request. The value can be the user's primary email address, alias email address, or unique user ID.",
              location: "path",
            },
          },
          description:
            "Updates a user. This method supports patch semantics, meaning that you only need to include the fields you wish to update. Fields that are not present in the request will be preserved, and fields set to `null` will be cleared. For repeating fields that contain arrays, individual items in the array can't be patched piecemeal; they must be supplied in the request body with the desired values for all items. See the [user accounts guide](https://developers.google.com/workspace/admin/directory/v1/guides/manage-users#update_user) for more information.",
          path: "admin/directory/v1/users/{userKey}",
          parameterOrder: ["userKey"],
          httpMethod: "PUT",
          response: {
            $ref: "User",
          },
          id: "directory.users.update",
          flatPath: "admin/directory/v1/users/{userKey}",
          scopes: ["https://www.googleapis.com/auth/admin.directory.user"],
          request: {
            $ref: "User",
          },
        },
        patch: {
          request: {
            $ref: "User",
          },
          flatPath: "admin/directory/v1/users/{userKey}",
          id: "directory.users.patch",
          httpMethod: "PATCH",
          path: "admin/directory/v1/users/{userKey}",
          scopes: ["https://www.googleapis.com/auth/admin.directory.user"],
          parameterOrder: ["userKey"],
          response: {
            $ref: "User",
          },
          description:
            "Updates a user using patch semantics. The update method should be used instead, because it also supports patch semantics and has better performance. If you're mapping an external identity to a Google identity, use the [`update`](https://developers.google.com/workspace/admin/directory/v1/reference/users/update) method instead of the `patch` method. This method is unable to clear fields that contain repeated objects (`addresses`, `phones`, etc). Use the update method instead.",
          parameters: {
            userKey: {
              type: "string",
              location: "path",
              description:
                "Identifies the user in the API request. The value can be the user's primary email address, alias email address, or unique user ID.",
              required: true,
            },
          },
        },
        delete: {
          path: "admin/directory/v1/users/{userKey}",
          description: "Deletes a user.",
          httpMethod: "DELETE",
          scopes: ["https://www.googleapis.com/auth/admin.directory.user"],
          parameterOrder: ["userKey"],
          id: "directory.users.delete",
          flatPath: "admin/directory/v1/users/{userKey}",
          parameters: {
            userKey: {
              type: "string",
              description:
                "Identifies the user in the API request. The value can be the user's primary email address, alias email address, or unique user ID.",
              required: true,
              location: "path",
            },
          },
        },
        makeAdmin: {
          path: "admin/directory/v1/users/{userKey}/makeAdmin",
          description: "Makes a user a super administrator.",
          httpMethod: "POST",
          scopes: ["https://www.googleapis.com/auth/admin.directory.user"],
          parameterOrder: ["userKey"],
          id: "directory.users.makeAdmin",
          flatPath: "admin/directory/v1/users/{userKey}/makeAdmin",
          request: { $ref: "UserMakeAdmin" },
          parameters: {
            userKey: {
              type: "string",
              required: true,
              location: "path",
              description:
                "Identifies the user in the API request. The value can be the user's primary email address, alias email address, or unique user ID.",
            },
          },
        },
      },
    },
    groups: {
      methods: {
        list: {
          response: {
            $ref: "Groups",
          },
          scopes: [
            "https://www.googleapis.com/auth/admin.directory.group",
            "https://www.googleapis.com/auth/admin.directory.group.readonly",
          ],
          parameterOrder: [],
          description: "Retrieves all groups of a domain or of a user given a userKey (paginated).",
          id: "directory.groups.list",
          flatPath: "admin/directory/v1/groups",
          path: "admin/directory/v1/groups",
          parameters: {
            domain: {
              location: "query",
              type: "string",
              description:
                "The domain name. Use this field to get groups from only one domain. To return all domains for a customer account, use the `customer` query parameter instead.",
            },
            userKey: {
              location: "query",
              type: "string",
              description:
                "Email or immutable ID of the user if only those groups are to be listed, the given user is a member of. If it's an ID, it should match with the ID of the user object. Cannot be used with the `customer` parameter.",
            },
            maxResults: {
              location: "query",
              format: "int32",
              minimum: "1",
              type: "integer",
              default: "200",
              description: "Maximum number of results to return. Max allowed value is 200.",
            },
            customer: {
              description:
                "The unique ID for the customer's Google Workspace account. In case of a multi-domain account, to fetch all groups for a customer, use this field instead of `domain`. You can also use the `my_customer` alias to represent your account's `customerId`. The `customerId` is also returned as part of the [Users](https://developers.google.com/workspace/admin/directory/v1/reference/users) resource. You must provide either the `customer` or the `domain` parameter.",
              type: "string",
              location: "query",
            },
            orderBy: {
              enum: ["email"],
              location: "query",
              type: "string",
              enumDescriptions: ["Email of the group."],
              description: "Column to use for sorting results",
            },
            pageToken: {
              location: "query",
              description: "Token to specify next page in the list",
              type: "string",
            },
            sortOrder: {
              enumDescriptions: ["Ascending order.", "Descending order."],
              type: "string",
              enum: ["ASCENDING", "DESCENDING"],
              location: "query",
              description:
                "Whether to return results in ascending or descending order. Only of use when orderBy is also used",
            },
            query: {
              description:
                "Query string search. Contains one or more search clauses, each with a field, operator, and value. For complete documentation, go to [Search for groups](https://developers.google.com/workspace/admin/directory/v1/guides/search-groups).",
              type: "string",
              location: "query",
            },
          },
          httpMethod: "GET",
        },
        get: {
          flatPath: "admin/directory/v1/groups/{groupKey}",
          path: "admin/directory/v1/groups/{groupKey}",
          parameterOrder: ["groupKey"],
          id: "directory.groups.get",
          scopes: [
            "https://www.googleapis.com/auth/admin.directory.group",
            "https://www.googleapis.com/auth/admin.directory.group.readonly",
          ],
          description: "Retrieves a group's properties.",
          httpMethod: "GET",
          response: {
            $ref: "Group",
          },
          parameters: {
            groupKey: {
              description:
                "Identifies the group in the API request. The value can be the group's email address, group alias, or the unique group ID.",
              required: true,
              type: "string",
              location: "path",
            },
          },
        },
        insert: {
          httpMethod: "POST",
          request: {
            $ref: "Group",
          },
          scopes: ["https://www.googleapis.com/auth/admin.directory.group"],
          response: {
            $ref: "Group",
          },
          parameters: {},
          parameterOrder: [],
          path: "admin/directory/v1/groups",
          description: "Creates a group.",
          flatPath: "admin/directory/v1/groups",
          id: "directory.groups.insert",
        },
        update: {
          id: "directory.groups.update",
          parameters: {
            groupKey: {
              required: true,
              type: "string",
              location: "path",
              description:
                "Identifies the group in the API request. The value can be the group's email address, group alias, or the unique group ID.",
            },
          },
          path: "admin/directory/v1/groups/{groupKey}",
          flatPath: "admin/directory/v1/groups/{groupKey}",
          httpMethod: "PUT",
          request: {
            $ref: "Group",
          },
          parameterOrder: ["groupKey"],
          scopes: ["https://www.googleapis.com/auth/admin.directory.group"],
          response: {
            $ref: "Group",
          },
          description: "Updates a group's properties.",
        },
        patch: {
          httpMethod: "PATCH",
          request: {
            $ref: "Group",
          },
          scopes: ["https://www.googleapis.com/auth/admin.directory.group"],
          flatPath: "admin/directory/v1/groups/{groupKey}",
          parameterOrder: ["groupKey"],
          parameters: {
            groupKey: {
              location: "path",
              description:
                "Identifies the group in the API request. The value can be the group's email address, group alias, or the unique group ID.",
              required: true,
              type: "string",
            },
          },
          response: {
            $ref: "Group",
          },
          id: "directory.groups.patch",
          path: "admin/directory/v1/groups/{groupKey}",
          description:
            "Updates a group's properties. This method supports [patch semantics](https://developers.google.com/workspace/admin/directory/v1/guides/performance#patch).",
        },
        delete: {
          httpMethod: "DELETE",
          id: "directory.groups.delete",
          description: "Deletes a group.",
          flatPath: "admin/directory/v1/groups/{groupKey}",
          parameters: {
            groupKey: {
              required: true,
              location: "path",
              description:
                "Identifies the group in the API request. The value can be the group's email address, group alias, or the unique group ID.",
              type: "string",
            },
          },
          path: "admin/directory/v1/groups/{groupKey}",
          scopes: ["https://www.googleapis.com/auth/admin.directory.group"],
          parameterOrder: ["groupKey"],
        },
      },
    },
    members: {
      methods: {
        list: {
          description:
            "Retrieves a paginated list of all members in a group. This method times out after 60 minutes. For more information, see [Troubleshoot error codes](https://developers.google.com/workspace/admin/directory/v1/guides/troubleshoot-error-codes).",
          path: "admin/directory/v1/groups/{groupKey}/members",
          flatPath: "admin/directory/v1/groups/{groupKey}/members",
          id: "directory.members.list",
          parameterOrder: ["groupKey"],
          parameters: {
            groupKey: {
              location: "path",
              required: true,
              description:
                "Identifies the group in the API request. The value can be the group's email address, group alias, or the unique group ID.",
              type: "string",
            },
            maxResults: {
              format: "int32",
              location: "query",
              type: "integer",
              description: "Maximum number of results to return. Max allowed value is 200.",
              default: "200",
              minimum: "1",
            },
            pageToken: {
              location: "query",
              description: "Token to specify next page in the list.",
              type: "string",
            },
            includeDerivedMembership: {
              type: "boolean",
              location: "query",
              description: "Whether to list indirect memberships. Default: false.",
            },
            roles: {
              type: "string",
              description:
                "The `roles` query parameter allows you to retrieve group members by role. Allowed values are `OWNER`, `MANAGER`, and `MEMBER`.",
              location: "query",
            },
          },
          httpMethod: "GET",
          response: {
            $ref: "Members",
          },
          scopes: [
            "https://www.googleapis.com/auth/admin.directory.group",
            "https://www.googleapis.com/auth/admin.directory.group.member",
            "https://www.googleapis.com/auth/admin.directory.group.member.readonly",
            "https://www.googleapis.com/auth/admin.directory.group.readonly",
          ],
        },
        get: {
          description: "Retrieves a group member's properties.",
          parameterOrder: ["groupKey", "memberKey"],
          flatPath: "admin/directory/v1/groups/{groupKey}/members/{memberKey}",
          path: "admin/directory/v1/groups/{groupKey}/members/{memberKey}",
          id: "directory.members.get",
          httpMethod: "GET",
          scopes: [
            "https://www.googleapis.com/auth/admin.directory.group",
            "https://www.googleapis.com/auth/admin.directory.group.member",
            "https://www.googleapis.com/auth/admin.directory.group.member.readonly",
            "https://www.googleapis.com/auth/admin.directory.group.readonly",
          ],
          parameters: {
            memberKey: {
              description:
                "Identifies the group member in the API request. A group member can be a user or another group. The value can be the member's (group or user) primary email address, alias, or unique ID.",
              type: "string",
              required: true,
              location: "path",
            },
            groupKey: {
              type: "string",
              required: true,
              description:
                "Identifies the group in the API request. The value can be the group's email address, group alias, or the unique group ID.",
              location: "path",
            },
          },
          response: {
            $ref: "Member",
          },
        },
        hasMember: {
          scopes: [
            "https://www.googleapis.com/auth/admin.directory.group",
            "https://www.googleapis.com/auth/admin.directory.group.member",
            "https://www.googleapis.com/auth/admin.directory.group.member.readonly",
            "https://www.googleapis.com/auth/admin.directory.group.readonly",
          ],
          flatPath: "admin/directory/v1/groups/{groupKey}/hasMember/{memberKey}",
          description:
            "Checks whether the given user is a member of the group. Membership can be direct or nested, but if nested, the `memberKey` and `groupKey` must be entities in the same domain or an `Invalid input` error is returned. To check for nested memberships that include entities outside of the group's domain, use the [`checkTransitiveMembership()`](https://cloud.google.com/identity/docs/reference/rest/v1/groups.memberships/checkTransitiveMembership) method in the Cloud Identity Groups API.",
          httpMethod: "GET",
          response: {
            $ref: "MembersHasMember",
          },
          parameterOrder: ["groupKey", "memberKey"],
          id: "directory.members.hasMember",
          path: "admin/directory/v1/groups/{groupKey}/hasMember/{memberKey}",
          parameters: {
            memberKey: {
              type: "string",
              required: true,
              description:
                "Identifies the user member in the API request. The value can be the user's primary email address, alias, or unique ID.",
              location: "path",
            },
            groupKey: {
              type: "string",
              description:
                "Identifies the group in the API request. The value can be the group's email address, group alias, or the unique group ID.",
              location: "path",
              required: true,
            },
          },
        },
        insert: {
          parameterOrder: ["groupKey"],
          request: {
            $ref: "Member",
          },
          parameters: {
            groupKey: {
              type: "string",
              description:
                "Identifies the group in the API request. The value can be the group's email address, group alias, or the unique group ID.",
              required: true,
              location: "path",
            },
          },
          flatPath: "admin/directory/v1/groups/{groupKey}/members",
          scopes: [
            "https://www.googleapis.com/auth/admin.directory.group",
            "https://www.googleapis.com/auth/admin.directory.group.member",
          ],
          httpMethod: "POST",
          path: "admin/directory/v1/groups/{groupKey}/members",
          id: "directory.members.insert",
          description: "Adds a user to the specified group.",
          response: {
            $ref: "Member",
          },
        },
        update: {
          flatPath: "admin/directory/v1/groups/{groupKey}/members/{memberKey}",
          parameterOrder: ["groupKey", "memberKey"],
          id: "directory.members.update",
          parameters: {
            memberKey: {
              type: "string",
              required: true,
              location: "path",
              description:
                "Identifies the group member in the API request. A group member can be a user or another group. The value can be the member's (group or user) primary email address, alias, or unique ID.",
            },
            groupKey: {
              description:
                "Identifies the group in the API request. The value can be the group's email address, group alias, or the unique group ID.",
              type: "string",
              location: "path",
              required: true,
            },
          },
          httpMethod: "PUT",
          path: "admin/directory/v1/groups/{groupKey}/members/{memberKey}",
          scopes: [
            "https://www.googleapis.com/auth/admin.directory.group",
            "https://www.googleapis.com/auth/admin.directory.group.member",
          ],
          response: {
            $ref: "Member",
          },
          description: "Updates the membership of a user in the specified group.",
          request: {
            $ref: "Member",
          },
        },
        patch: {
          parameters: {
            memberKey: {
              type: "string",
              description:
                "Identifies the group member in the API request. A group member can be a user or another group. The value can be the member's (group or user) primary email address, alias, or unique ID.",
              required: true,
              location: "path",
            },
            groupKey: {
              type: "string",
              location: "path",
              description:
                "Identifies the group in the API request. The value can be the group's email address, group alias, or the unique group ID.",
              required: true,
            },
          },
          id: "directory.members.patch",
          response: {
            $ref: "Member",
          },
          httpMethod: "PATCH",
          description:
            "Updates the membership properties of a user in the specified group. This method supports [patch semantics](https://developers.google.com/workspace/admin/directory/v1/guides/performance#patch).",
          flatPath: "admin/directory/v1/groups/{groupKey}/members/{memberKey}",
          parameterOrder: ["groupKey", "memberKey"],
          scopes: [
            "https://www.googleapis.com/auth/admin.directory.group",
            "https://www.googleapis.com/auth/admin.directory.group.member",
          ],
          path: "admin/directory/v1/groups/{groupKey}/members/{memberKey}",
          request: {
            $ref: "Member",
          },
        },
        delete: {
          parameterOrder: ["groupKey", "memberKey"],
          scopes: [
            "https://www.googleapis.com/auth/admin.directory.group",
            "https://www.googleapis.com/auth/admin.directory.group.member",
          ],
          parameters: {
            groupKey: {
              required: true,
              location: "path",
              description:
                "Identifies the group in the API request. The value can be the group's email address, group alias, or the unique group ID.",
              type: "string",
            },
            memberKey: {
              description:
                "Identifies the group member in the API request. A group member can be a user or another group. The value can be the member's (group or user) primary email address, alias, or unique ID.",
              required: true,
              location: "path",
              type: "string",
            },
          },
          flatPath: "admin/directory/v1/groups/{groupKey}/members/{memberKey}",
          id: "directory.members.delete",
          httpMethod: "DELETE",
          path: "admin/directory/v1/groups/{groupKey}/members/{memberKey}",
          description: "Removes a member from a group.",
        },
      },
    },
  },
} as const;

/** The OAuth scopes each Directory route accepts, keyed as `METHOD /path/:param`, from the methods above. */
export const directoryRouteScopes: Record<string, readonly string[]> = Object.fromEntries(
  Object.values(document.resources).flatMap((resource) =>
    Object.values(resource.methods).map((method) => [
      `${method.httpMethod} /${method.flatPath.replace(/\{(\w+)\}/g, ":$1")}`,
      method.scopes,
    ]),
  ),
);

export function buildDirectoryDiscoveryDocument(baseUrl: string) {
  const rootUrl = `${baseUrl.replace(/\/$/, "")}/`;
  return { ...document, rootUrl, baseUrl: rootUrl, servicePath: "", basePath: "", batchPath: "batch" };
}
