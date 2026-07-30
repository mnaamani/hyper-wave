// Country onboarding AND the country switcher — the mobile counterpart of the desktop intro plus
// its `#myflag` topbar button (renderer/lib/hud.js). The chosen country is the engine's cosmetic
// peer `tag`, so it rides the heartbeat and appears as a flag on this peer's ring seat and on the
// moments it posts.
//
// The choice is a plain preference (not a secret), persisted next to the store by custody.js, so
// onboarding is asked exactly once — after that, tapping the header flag reopens this to change it.
//
// `onClose` is what separates the two jobs: during ONBOARDING it is absent and there is no way out
// but choosing (which is the point). Once a country exists the caller passes one, and a Cancel
// appears — a mistaken tap on the flag must not trap the user, and backing out must leave the
// existing country untouched.
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
 * @param {(() => void)|null} [props.onClose] - Dismiss without changing anything. Omit during
 *   onboarding (no country yet) so the only way on is to choose one.
 * @returns {JSX.Element} The picker.
 */
export function CountryPicker({ visible, onPick, onClose }) {
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
    <Modal
      visible={visible}
      animationType='slide'
      transparent={false}
      onRequestClose={() => onClose?.()}
    >
      <View style={styles.screen}>
        <View style={styles.head}>
          <Text style={styles.title}>⚡ Where are you waving from?</Text>
          {onClose ? (
            <Pressable
              onPress={onClose}
              style={styles.close}
              accessibilityLabel='Keep my current country'
            >
              <Text style={styles.closeText}>✕</Text>
            </Pressable>
          ) : null}
        </View>
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
  head: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between'
  },
  title: {
    flex: 1,
    color: PALETTE.text,
    fontSize: 22,
    fontWeight: '700',
    paddingHorizontal: 16
  },
  close: { paddingHorizontal: 16, paddingVertical: 2 },
  closeText: { color: PALETTE.muted, fontSize: 22, fontWeight: '600' },
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
