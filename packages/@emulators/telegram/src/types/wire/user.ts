// Wire shape emitted when a `User` object appears on an update (Bot API
// `User`). Produced by serializeUser / serializeBotAsUser — which is
// why both bot-flavoured and user-flavoured fields are optional here.
export interface WireUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

// Bots always have is_bot: true and carry a username. The type keeps
// that invariant visible at the producing boundary.
export interface WireBotAsUser {
  id: number;
  is_bot: true;
  first_name: string;
  username: string;
}
