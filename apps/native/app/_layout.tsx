import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";

/**
 * Root layout. Expo Router builds the navigator from the file tree, so every
 * sibling of this file becomes a screen in this Stack automatically.
 */
export default function RootLayout() {
  return (
    <>
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          headerShown: true,
        }}
      >
        <Stack.Screen name="index" options={{ title: "Astro" }} />
        <Stack.Screen
          name="+not-found"
          options={{ title: "Not found", presentation: "modal" }}
        />
      </Stack>
    </>
  );
}
