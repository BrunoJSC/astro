import { nativeEnv } from "@repo/env/native";
import { StyleSheet, Text, View } from "react-native";
import { useSession } from "../lib/auth-client";

export default function HomeScreen() {
  const { data: session, isPending } = useSession();

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Astro</Text>

      <Text style={styles.body}>
        {isPending
          ? "Checking session..."
          : (session?.user.email ?? "Not signed in")}
      </Text>

      {/* Proves the T3 Env wiring at a glance: an unset or malformed
          EXPO_PUBLIC_API_URL fails validation before this screen renders. */}
      <Text style={styles.caption}>API: {nativeEnv.EXPO_PUBLIC_API_URL}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    fontSize: 16,
    opacity: 0.8,
  },
  caption: {
    fontSize: 12,
    opacity: 0.5,
  },
  container: {
    alignItems: "center",
    flex: 1,
    gap: 12,
    justifyContent: "center",
    padding: 24,
  },
  title: {
    fontSize: 28,
    fontWeight: "600",
  },
});
