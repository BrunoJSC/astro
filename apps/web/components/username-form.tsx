"use client";

import { authClient } from "@repo/auth/client";
import { Button } from "@repo/ui/components";
import { useEffect, useState } from "react";

type Availability = "idle" | "checking" | "available" | "taken" | "invalid";

/**
 * Sign-up with a live availability check, then sign-in by username.
 *
 * The check is debounced because `isUsernameAvailable` is a database round trip
 * per keystroke otherwise -- and an un-debounced field is also a cheap way for
 * anyone to enumerate which handles exist.
 */
export function UsernameForm() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [availability, setAvailability] = useState<Availability>("idle");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    // Below the plugin's minUsernameLength there is nothing worth asking about.
    if (username.length < 3) {
      setAvailability("idle");
      return;
    }

    setAvailability("checking");
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      const { data, error } = await authClient.isUsernameAvailable({
        username,
        fetchOptions: { signal: controller.signal },
      });

      if (controller.signal.aborted) {
        return;
      }

      // A rejected username (dots, too long) is an error, not "taken" --
      // showing them apart is the difference between "pick another" and
      // "that is not a valid handle".
      if (error) {
        setAvailability("invalid");
        return;
      }

      setAvailability(data?.available ? "available" : "taken");
    }, 400);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [username]);

  async function handleSignUp() {
    const { error } = await authClient.signUp.email({
      email: `${username}@example.com`,
      name: username,
      password,
      // Stored lower-cased; `displayUsername` keeps the casing as typed.
      username,
      displayUsername: username,
    });
    setMessage(error ? (error.message ?? "Sign-up failed") : "Account created");
  }

  async function handleSignIn() {
    // Case-insensitive: the server normalizes before looking the handle up.
    const { data, error } = await authClient.signIn.username({
      username,
      password,
    });
    setMessage(
      error
        ? (error.message ?? "Sign-in failed")
        : `Signed in as ${data?.user.username}`,
    );
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => e.preventDefault()}>
      <label className="flex flex-col gap-1 text-sm" htmlFor="username">
        Username
        <input
          className="rounded-md border bg-background px-3 py-2"
          id="username"
          onChange={(event) => setUsername(event.target.value)}
          value={username}
        />
      </label>

      <p className="text-muted-foreground text-xs">
        {availability === "checking" && "Checking..."}
        {availability === "available" && "Available"}
        {availability === "taken" && "Already taken"}
        {availability === "invalid" && "Letters, digits and underscore only"}
      </p>

      <label className="flex flex-col gap-1 text-sm" htmlFor="password">
        Password
        <input
          className="rounded-md border bg-background px-3 py-2"
          id="password"
          onChange={(event) => setPassword(event.target.value)}
          type="password"
          value={password}
        />
      </label>

      <div className="flex gap-2">
        <Button disabled={availability !== "available"} onClick={handleSignUp}>
          Sign up
        </Button>
        <Button onClick={handleSignIn} variant="outline">
          Sign in
        </Button>
      </div>

      {message ? <p className="text-sm">{message}</p> : null}
    </form>
  );
}
