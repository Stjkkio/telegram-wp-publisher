<?php
/**
 * Plugin Name:  Telegram WP Publisher
 * Description:  Custom REST API endpoints for the Telegram WP Publisher bot.
 *               Handles post creation, media upload, WPML linking, and RankMath meta.
 *               Requires TGWP_HMAC_SECRET defined in wp-config.php.
 * Version:      1.0.0
 * Requires PHP: 7.4
 * Author:       Your Name
 * License:      GPL2
 */

if ( ! defined( 'ABSPATH' ) ) exit;

// Some hosting providers place HTTP Basic Auth in front of WordPress at the
// server level. When this happens WordPress may see PHP_AUTH_USER/PW from the
// server and disable Application Passwords thinking the site uses Basic Auth.
// The bot sends server-level credentials in Authorization and WP credentials
// in X-Bot-Credential, so we clear the server auth vars here — Apache has
// already validated the server-level credentials before PHP runs.
if ( isset( $_SERVER['HTTP_X_BOT_CREDENTIAL'] ) ) {
    unset( $_SERVER['PHP_AUTH_USER'], $_SERVER['PHP_AUTH_PW'] );
}

// Force Application Passwords on. Some hosting reverse proxies hide HTTPS
// from WordPress, which can cause WP to disable Application Passwords.
// Priority 999 ensures we run after any hosting-level filters.
add_filter( 'wp_is_application_passwords_available',          '__return_true', 999 );
add_filter( 'wp_is_application_passwords_available_for_user', '__return_true', 999 );

// ─── Role setup ───────────────────────────────────────────────────────────────

register_activation_hook( __FILE__, 'tgwp_create_role' );

function tgwp_create_role() {
    add_role( 'tgwp_publisher', 'TGWP Publisher', [
        'read'                   => true,
        'upload_files'           => true,
        'edit_posts'             => true,
        'publish_posts'          => true,
        'delete_posts'           => true,
        'edit_published_posts'   => true,
        'delete_published_posts' => true,
    ] );
}

register_deactivation_hook( __FILE__, function () {
    remove_role( 'tgwp_publisher' );
} );

// ─── Route registration ───────────────────────────────────────────────────────

add_action( 'rest_api_init', 'tgwp_register_routes' );

function tgwp_register_routes() {
    $ns   = 'tgwp/v1';
    $perm = 'tgwp_verify_request';

    register_rest_route( $ns, '/health', [
        'methods'             => 'GET',
        'callback'            => 'tgwp_health',
        'permission_callback' => $perm,
    ] );

    register_rest_route( $ns, '/media', [
        'methods'             => 'POST',
        'callback'            => 'tgwp_upload_media',
        'permission_callback' => $perm,
    ] );

    register_rest_route( $ns, '/posts', [
        'methods'             => 'POST',
        'callback'            => 'tgwp_create_post',
        'permission_callback' => $perm,
    ] );

    register_rest_route( $ns, '/wpml/link', [
        'methods'             => 'POST',
        'callback'            => 'tgwp_wpml_link',
        'permission_callback' => $perm,
    ] );

    register_rest_route( $ns, '/posts/(?P<id>\d+)', [
        'methods'             => 'DELETE',
        'callback'            => 'tgwp_delete_post',
        'permission_callback' => $perm,
        'args'                => [
            'id' => [
                'required'          => true,
                'validate_callback' => fn( $v ) => is_numeric( $v ) && intval( $v ) > 0,
            ],
        ],
    ] );
}

// ─── HMAC verification ────────────────────────────────────────────────────────

function tgwp_verify_request( WP_REST_Request $request ) {
    // 1. Secret must be defined in wp-config.php
    if ( ! defined( 'TGWP_HMAC_SECRET' ) || empty( TGWP_HMAC_SECRET ) ) {
        return new WP_Error( 'config_error', 'HMAC secret not configured on server', [ 'status' => 500 ] );
    }
    $secret = TGWP_HMAC_SECRET;

    // 2. Required headers
    $timestamp = $request->get_header( 'X-TGWP-Timestamp' );
    $signature = $request->get_header( 'X-TGWP-Signature' );

    if ( ! $timestamp || ! $signature ) {
        return new WP_Error( 'missing_headers', 'Missing HMAC headers', [ 'status' => 401 ] );
    }

    // 3. Replay protection: ±5 minutes
    if ( abs( time() - intval( $timestamp ) ) > 300 ) {
        return new WP_Error( 'timestamp_expired', 'Request timestamp outside allowed window', [ 'status' => 401 ] );
    }

    // 4. Compute canonical string and verify signature
    $method = $request->get_method();
    $route  = '/wp-json' . $request->get_route();

    $content_type = $request->get_content_type();
    $is_multipart = $content_type && strpos( $content_type['value'] ?? '', 'multipart' ) !== false;

    if ( $is_multipart && ! empty( $_FILES['file']['tmp_name'] ) ) {
        $body_hash = hash_file( 'sha256', $_FILES['file']['tmp_name'] );
    } else {
        $body_hash = hash( 'sha256', $request->get_body() ?: '' );
    }

    $canonical = implode( "\n", [ $method, $route, $timestamp, $body_hash ] );
    $expected  = hash_hmac( 'sha256', $canonical, $secret );

    if ( ! hash_equals( $expected, strtolower( $signature ) ) ) {
        return new WP_Error( 'invalid_signature', 'HMAC signature mismatch', [ 'status' => 403 ] );
    }

    // 5. Authenticate via WP Application Password.
    // When a server-level HTTP auth sits in front of WordPress, the bot sends
    // WP credentials in X-Bot-Credential to avoid colliding with the server's
    // Authorization header. Fall back to Authorization if the custom header is absent.
    $auth_header = $request->get_header( 'X-Bot-Credential' ) ?: $request->get_header( 'Authorization' );
    if ( ! $auth_header || stripos( $auth_header, 'Basic ' ) !== 0 ) {
        return new WP_Error( 'no_auth', 'Missing Authorization header', [ 'status' => 401 ] );
    }

    $decoded = base64_decode( substr( $auth_header, 6 ) );
    $parts   = explode( ':', $decoded, 2 );
    if ( count( $parts ) !== 2 ) {
        return new WP_Error( 'bad_auth', 'Malformed Authorization header', [ 'status' => 401 ] );
    }

    $user = wp_authenticate( $parts[0], $parts[1] );
    if ( is_wp_error( $user ) ) {
        return new WP_Error( 'unauthorized', 'Invalid WordPress credentials', [ 'status' => 401 ] );
    }

    wp_set_current_user( $user->ID );

    if ( ! current_user_can( 'edit_posts' ) ) {
        return new WP_Error( 'forbidden', 'Insufficient permissions', [ 'status' => 403 ] );
    }

    return true;
}

// ─── GET /health ──────────────────────────────────────────────────────────────

function tgwp_health() {
    return rest_ensure_response( [ 'status' => 'ok', 'timestamp' => time() ] );
}

// ─── POST /media ──────────────────────────────────────────────────────────────

function tgwp_upload_media( WP_REST_Request $request ) {
    if ( empty( $_FILES['file'] ) ) {
        return new WP_Error( 'no_file', 'No file uploaded', [ 'status' => 400 ] );
    }

    $allowed_types = [ 'image/jpeg', 'image/png', 'image/gif', 'image/webp' ];
    $file_type     = mime_content_type( $_FILES['file']['tmp_name'] );
    if ( ! in_array( $file_type, $allowed_types, true ) ) {
        return new WP_Error( 'invalid_type', 'File type not allowed: ' . $file_type, [ 'status' => 400 ] );
    }

    require_once ABSPATH . 'wp-admin/includes/file.php';
    require_once ABSPATH . 'wp-admin/includes/media.php';
    require_once ABSPATH . 'wp-admin/includes/image.php';

    $attachment_id = media_handle_upload( 'file', 0 );

    if ( is_wp_error( $attachment_id ) ) {
        return new WP_Error( 'upload_failed', $attachment_id->get_error_message(), [ 'status' => 500 ] );
    }

    return rest_ensure_response( [
        'id'  => $attachment_id,
        'url' => wp_get_attachment_url( $attachment_id ),
    ] );
}

// ─── POST /posts ──────────────────────────────────────────────────────────────

function tgwp_create_post( WP_REST_Request $request ) {
    $params   = $request->get_json_params();
    $required = [ 'lang', 'title', 'slug', 'content', 'meta_description', 'status' ];

    foreach ( $required as $field ) {
        if ( empty( $params[ $field ] ) ) {
            return new WP_Error( 'missing_field', "Missing required field: {$field}", [ 'status' => 400 ] );
        }
    }

    $lang      = sanitize_text_field( $params['lang'] );
    $title     = sanitize_text_field( $params['title'] );
    $slug      = sanitize_title( $params['slug'] );
    $content   = wp_kses_post( $params['content'] );
    $meta      = sanitize_text_field( $params['meta_description'] );
    $status    = in_array( $params['status'], [ 'draft', 'publish' ], true ) ? $params['status'] : 'draft';
    $author_id = ! empty( $params['author_id'] ) ? intval( $params['author_id'] ) : 0;

    $featured_image_id    = ! empty( $params['featured_image_id'] ) ? intval( $params['featured_image_id'] ) : 0;
    $additional_media_ids = ! empty( $params['additional_media_ids'] ) ? array_map( 'intval', (array) $params['additional_media_ids'] ) : [];

    // Verify WPML language is active
    if ( function_exists( 'icl_get_languages' ) ) {
        $active_langs = array_keys( icl_get_languages( 'skip_missing=0' ) );
        if ( ! in_array( $lang, $active_langs, true ) ) {
            return new WP_Error( 'invalid_lang', "Language '{$lang}' is not active in WPML", [ 'status' => 400 ] );
        }
    }

    // Resolve slug conflicts deterministically
    $requested_slug = $slug;
    $final_slug     = tgwp_resolve_slug( $slug );

    // Switch WPML language context for post insertion
    if ( function_exists( 'do_action' ) ) {
        do_action( 'wpml_switch_language', $lang );
    }

    $insert_args = [
        'post_title'   => $title,
        'post_name'    => $final_slug,
        'post_content' => $content,
        'post_status'  => $status,
        'post_type'    => 'post',
    ];

    // Set author if provided and the user exists
    if ( $author_id > 0 && get_user_by( 'id', $author_id ) ) {
        $insert_args['post_author'] = $author_id;
    }

    $post_id = wp_insert_post( $insert_args, true );

    if ( is_wp_error( $post_id ) ) {
        return new WP_Error( 'post_failed', $post_id->get_error_message(), [ 'status' => 500 ] );
    }

    // Set WPML language for the post
    do_action( 'wpml_set_element_language_details', [
        'element_id'           => $post_id,
        'element_type'         => 'post_post',
        'trid'                 => null,
        'language_code'        => $lang,
        'source_language_code' => null,
    ] );

    // RankMath meta description
    update_post_meta( $post_id, 'rank_math_description', $meta );

    // Featured image
    if ( $featured_image_id ) {
        set_post_thumbnail( $post_id, $featured_image_id );
    }

    // Associate additional media with this post
    foreach ( $additional_media_ids as $media_id ) {
        wp_update_post( [ 'ID' => $media_id, 'post_parent' => $post_id ] );
    }

    return rest_ensure_response( [
        'id'             => $post_id,
        'url'            => get_permalink( $post_id ),
        'slug_requested' => $requested_slug,
        'slug_final'     => $final_slug,
    ] );
}

/**
 * Resolve slug conflicts by appending a numeric suffix (-2, -3, ...).
 */
function tgwp_resolve_slug( string $slug, int $suffix = 2 ): string {
    global $wpdb;

    $exists = $wpdb->get_var( $wpdb->prepare(
        "SELECT ID FROM {$wpdb->posts} WHERE post_name = %s AND post_status != 'trash' LIMIT 1",
        $slug
    ) );

    if ( ! $exists ) return $slug;

    return tgwp_resolve_slug( $slug . '-' . $suffix, $suffix + 1 );
}

// ─── POST /wpml/link ──────────────────────────────────────────────────────────

function tgwp_wpml_link( WP_REST_Request $request ) {
    $params = $request->get_json_params();

    if ( empty( $params['it_post_id'] ) || empty( $params['en_post_id'] ) ) {
        return new WP_Error( 'missing_ids', 'Missing it_post_id or en_post_id', [ 'status' => 400 ] );
    }

    if ( ! function_exists( 'wpml_set_element_language_details' ) && ! has_action( 'wpml_set_element_language_details' ) ) {
        return new WP_Error( 'wpml_missing', 'WPML is not active', [ 'status' => 500 ] );
    }

    $it_id = intval( $params['it_post_id'] );
    $en_id = intval( $params['en_post_id'] );

    // Get the trid (translation group ID) from the Italian post
    $it_lang_details = apply_filters( 'wpml_element_language_details', null, [
        'element_id'   => $it_id,
        'element_type' => 'post_post',
    ] );

    $trid = $it_lang_details->trid ?? null;

    // Link English post to the same trid as a translation of Italian
    do_action( 'wpml_set_element_language_details', [
        'element_id'           => $en_id,
        'element_type'         => 'post_post',
        'trid'                 => $trid,
        'language_code'        => 'en',
        'source_language_code' => 'it',
    ] );

    return rest_ensure_response( [ 'linked' => true, 'trid' => $trid ] );
}

// ─── DELETE /posts/{id} ───────────────────────────────────────────────────────

function tgwp_delete_post( WP_REST_Request $request ) {
    $post_id = intval( $request->get_param( 'id' ) );

    if ( ! get_post( $post_id ) ) {
        return new WP_Error( 'not_found', "Post {$post_id} not found", [ 'status' => 404 ] );
    }

    $result = wp_delete_post( $post_id, true );

    if ( ! $result ) {
        return new WP_Error( 'delete_failed', "Could not delete post {$post_id}", [ 'status' => 500 ] );
    }

    return rest_ensure_response( [ 'deleted' => true, 'id' => $post_id ] );
}
