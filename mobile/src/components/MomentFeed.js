// The moment feed — the phone's primary surface. One moment per full-bleed page, swipe up for the
// next: the vertical pager every phone user already knows. It replaces the desktop's ring-centre
// stage plus the card list underneath it (the ring itself is gone on mobile — a 320pt circle on a
// 6" screen left no room for the content it was framing).
//
// It is presentation only. The order is the feed's own hop order (the CRDT's deterministic
// mergeFeed fold — every peer sees the same sequence), and nothing here writes to the engine
// except the tip button's callback.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Image,
  Pressable,
  FlatList,
  StyleSheet
} from 'react-native';
import { flagOf } from 'hyperwave-app-core';
import { PALETTE } from '../theme';

/**
 * @param {Object} props - Props.
 * @param {Array<Object>} props.moments - The hop-ordered gallery.
 * @param {(moment: Object) => string} props.keyOf - Stable identity for a moment.
 * @param {number} props.index - The page to show (drives sweep auto-advance).
 * @param {(index: number) => void} props.onIndexChange - Fires when the user swipes.
 * @param {() => void} props.onManualScroll - Fires when the user takes control with a drag.
 * @param {(moment: Object) => void} props.onTip - Tip handler.
 * @param {(moment: Object) => boolean} props.canTip - Whether this moment is tippable.
 * @param {string} props.tipLabel - Label for the tip button (amount + unit).
 * @param {string} props.emptyText - Shown when the gallery is empty.
 * @returns {JSX.Element} The feed.
 */
export function MomentFeed({
  moments,
  keyOf,
  index,
  onIndexChange,
  onManualScroll,
  onTip,
  canTip,
  tipLabel,
  emptyText
}) {
  // The page height is the space this component was actually given (the screen minus whatever the
  // overlays sit over), so a page is always exactly one screenful — measured rather than assumed.
  const [pageHeight, setPageHeight] = useState(0);
  const listRef = useRef(null);

  const onLayout = useCallback((event) => {
    setPageHeight(Math.round(event.nativeEvent.layout.height));
  }, []);

  // Paging is exact (every page is pageHeight tall), so hand FlatList the geometry instead of
  // letting it measure — that's what makes scrollToIndex safe for the sweep's auto-advance.
  const getItemLayout = useCallback(
    (_data, itemIndex) => ({
      length: pageHeight,
      offset: pageHeight * itemIndex,
      index: itemIndex
    }),
    [pageHeight]
  );

  // Follow the page the parent asks for. While a wave rolls, App.js walks this forward with the
  // sweep — the wave IS the scroll — so a moment takes the screen as its seat's slot fires. The
  // parent stops moving it once the lap finishes or the user drags, after which the feed is
  // theirs to browse freely.
  //
  // `moments.length` is deliberately NOT a dependency: a moment landing must never re-issue a
  // scroll, or an arrival mid-browse would yank the list back under the user's thumb. Only a
  // genuine change of the requested page moves the feed. (The length is still READ here, to clamp
  // — reading it without depending on it is the point.)
  useEffect(() => {
    if (!listRef.current || !pageHeight || moments.length === 0) {
      return;
    }
    listRef.current.scrollToIndex({
      index: Math.max(0, Math.min(index, moments.length - 1)),
      animated: true
    });
  }, [index, pageHeight]);

  // Which page are we on now? Tracked from BOTH scroll-end events: a fling ends in
  // `onMomentumScrollEnd`, but a slow drag released without momentum only ever fires
  // `onScrollEndDrag` — and if we missed that, the parent's idea of the current page would go
  // stale and the next programmatic scroll would jump somewhere the user didn't ask for.
  const trackIndex = useCallback(
    (event) => {
      if (!pageHeight) {
        return;
      }
      const next = Math.round(event.nativeEvent.contentOffset.y / pageHeight);
      onIndexChange(Math.max(0, Math.min(next, moments.length - 1)));
    },
    [pageHeight, onIndexChange, moments.length]
  );

  const renderItem = useCallback(
    ({ item }) => (
      <View style={[styles.page, { height: pageHeight }]}>
        {item.image ? (
          <Image
            source={{ uri: item.image }}
            style={styles.image}
            resizeMode='cover'
          />
        ) : (
          <View style={styles.noImage}>
            <Text style={styles.noImageText}>no moment captured</Text>
          </View>
        )}

        {/* the caption rail, over the image — Instagram's bottom-left stack */}
        <View style={styles.overlay} pointerEvents='box-none'>
          <Text style={styles.caption} numberOfLines={3}>
            {flagOf(item.country)} {item.caption || ''}
          </Text>
          <Text style={styles.byline}>
            @{(item.peerId || '').slice(0, 8) || 'peer'}
            {typeof item.hopCount === 'number' ? ` · hop ${item.hopCount}` : ''}
          </Text>
          {canTip(item) ? (
            <Pressable style={styles.tip} onPress={() => onTip(item)}>
              <Text style={styles.tipText}>⚡ Tip {tipLabel}</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    ),
    [pageHeight, canTip, onTip, tipLabel]
  );

  return (
    <View style={styles.wrap} onLayout={onLayout}>
      {moments.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>{emptyText}</Text>
        </View>
      ) : null}
      {moments.length > 0 && pageHeight > 0 ? (
        <FlatList
          ref={listRef}
          data={moments}
          keyExtractor={keyOf}
          renderItem={renderItem}
          getItemLayout={getItemLayout}
          pagingEnabled
          showsVerticalScrollIndicator={false}
          onMomentumScrollEnd={trackIndex}
          onScrollEndDrag={trackIndex}
          onScrollBeginDrag={onManualScroll}
          // A page can be asked for before the row is realised (a long gallery scrolled far);
          // recover by measuring, then retrying, rather than throwing.
          onScrollToIndexFailed={(info) => {
            listRef.current?.scrollToOffset({
              offset: info.averageItemLength * info.index,
              animated: true
            });
          }}
          // The sweep drives this while it's rolling; a drag hands control back to the user
          // (App.js stops following once onManualScroll fires).
          initialScrollIndex={Math.min(index, moments.length - 1)}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  page: { width: '100%', backgroundColor: PALETTE.bg },
  image: { ...StyleSheet.absoluteFillObject, width: '100%', height: '100%' },
  noImage: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: PALETTE.panel
  },
  noImageText: { color: PALETTE.dim, fontSize: 13 },
  overlay: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 96,
    gap: 4
  },
  caption: {
    color: PALETTE.text,
    fontSize: 17,
    fontWeight: '600',
    textShadowColor: 'rgba(0,0,0,0.85)',
    textShadowRadius: 6
  },
  byline: {
    color: PALETTE.muted,
    fontSize: 12,
    textShadowColor: 'rgba(0,0,0,0.85)',
    textShadowRadius: 6
  },
  tip: {
    alignSelf: 'flex-start',
    marginTop: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: PALETTE.orange,
    backgroundColor: 'rgba(0,0,0,0.45)',
    paddingVertical: 7,
    paddingHorizontal: 14
  },
  tipText: { color: PALETTE.orange, fontWeight: '700', fontSize: 14 },
  empty: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 40
  },
  emptyText: {
    color: PALETTE.muted,
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22
  }
});
