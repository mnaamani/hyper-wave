// Country onboarding — the mobile counterpart of the desktop intro (renderer/lib/hud.js). The
// chosen country is the engine's cosmetic peer `tag`, so it rides the heartbeat and appears as a
// flag on this peer's ring seat and on the moments it posts.
//
// The choice is a plain preference (not a secret), persisted next to the store by custody.js, so
// onboarding is asked exactly once.
import { useMemo, useState } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  Pressable,
  FlatList,
  StyleSheet
} from 'react-native';
import { COUNTRIES, flagOf } from 'hyperwave-app-core';
import { PALETTE } from '../theme';

/**
 * @param {Object} props - Props.
 * @param {boolean} props.visible - Whether the picker is open.
 * @param {(code: string) => void} props.onPick - Called with the ISO code.
 * @returns {JSX.Element} The picker.
 */
export function CountryPicker({ visible, onPick }) {
  const [query, setQuery] = useState('');

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return COUNTRIES;
    }
    return COUNTRIES.filter(
      ([code, name]) =>
        name.toLowerCase().includes(needle) || code.toLowerCase() === needle
    );
  }, [query]);

  return (
    <Modal visible={visible} animationType='slide' transparent={false}>
      <View style={styles.screen}>
        <Text style={styles.title}>⚡ Where are you waving from?</Text>
        <Text style={styles.subtitle}>
          Your flag rides with your moment around the ring.
        </Text>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder='Search countries'
          placeholderTextColor={PALETTE.dim}
          autoCorrect={false}
          style={styles.search}
        />
        <FlatList
          data={matches}
          keyExtractor={([code]) => code}
          keyboardShouldPersistTaps='handled'
          renderItem={({ item: [code, name] }) => (
            <Pressable onPress={() => onPick(code)} style={styles.row}>
              <Text style={styles.rowText}>
                {flagOf(code)} {name}
              </Text>
            </Pressable>
          )}
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: PALETTE.bg, paddingTop: 64 },
  title: {
    color: PALETTE.text,
    fontSize: 22,
    fontWeight: '700',
    paddingHorizontal: 16
  },
  subtitle: {
    color: PALETTE.muted,
    fontSize: 13,
    paddingHorizontal: 16,
    paddingTop: 6
  },
  search: {
    margin: 16,
    padding: 12,
    borderRadius: 10,
    backgroundColor: PALETTE.panel,
    color: PALETTE.text
  },
  row: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: PALETTE.panelEdge
  },
  rowText: { color: PALETTE.text, fontSize: 16 }
});
