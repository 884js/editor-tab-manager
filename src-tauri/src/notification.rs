use lazy_static::lazy_static;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, ClassBuilder, Sel};
use objc2::{class, msg_send, sel};
use objc2_foundation::NSString;
use std::ffi::CStr;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

lazy_static! {
    static ref APP_HANDLE: Mutex<Option<AppHandle>> = Mutex::new(None);
}

#[derive(Clone, serde::Serialize)]
struct NotificationClickedPayload {
    project_path: String,
}

/// Register the custom delegate class for UNUserNotificationCenter.
/// Must be called once at app startup.
pub fn setup_notification_delegate(app_handle: AppHandle) {
    *APP_HANDLE.lock().unwrap() = Some(app_handle);

    unsafe {
        // Build a custom delegate class implementing UNUserNotificationCenterDelegate
        let delegate_class = register_delegate_class();

        // Get the shared UNUserNotificationCenter
        let center: *mut AnyObject = msg_send![class!(UNUserNotificationCenter), currentNotificationCenter];

        // Create an instance of our delegate
        let delegate: *mut AnyObject = msg_send![delegate_class, new];

        // Set the delegate
        let _: () = msg_send![center, setDelegate: delegate];
    }
}

/// Register the Objective-C delegate class at runtime.
fn register_delegate_class() -> &'static AnyClass {
    let class_name = CStr::from_bytes_with_nul(b"ETMNotificationDelegate\0").unwrap();

    // Check if class is already registered
    if let Some(cls) = AnyClass::get(class_name) {
        return cls;
    }

    let superclass = class!(NSObject);
    let mut builder = ClassBuilder::new(class_name, superclass)
        .expect("Failed to create ETMNotificationDelegate class");

    // Add the UNUserNotificationCenterDelegate protocol
    let protocol_name = CStr::from_bytes_with_nul(b"UNUserNotificationCenterDelegate\0").unwrap();
    if let Some(protocol) = objc2::runtime::AnyProtocol::get(protocol_name) {
        builder.add_protocol(protocol);
    }

    // userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:
    unsafe {
        builder.add_method(
            sel!(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:),
            did_receive_response as unsafe extern "C" fn(*mut AnyObject, Sel, *mut AnyObject, *mut AnyObject, *mut AnyObject),
        );

        // userNotificationCenter:willPresentNotification:withCompletionHandler:
        // This ensures notifications are shown even when the app is in the foreground
        builder.add_method(
            sel!(userNotificationCenter:willPresentNotification:withCompletionHandler:),
            will_present_notification as unsafe extern "C" fn(*mut AnyObject, Sel, *mut AnyObject, *mut AnyObject, *mut AnyObject),
        );
    }

    builder.register()
}

/// Called when user interacts with a notification (click, dismiss, etc.)
unsafe extern "C" fn did_receive_response(
    _this: *mut AnyObject,
    _sel: Sel,
    _center: *mut AnyObject,
    response: *mut AnyObject,
    completion_handler: *mut AnyObject,
) {
    // Get the notification from the response
    let notification: *mut AnyObject = msg_send![response, notification];
    let request: *mut AnyObject = msg_send![notification, request];
    let content: *mut AnyObject = msg_send![request, content];
    let user_info: *mut AnyObject = msg_send![content, userInfo];

    // Extract projectPath from userInfo
    let key = NSString::from_str("projectPath");
    let value: *mut AnyObject = msg_send![user_info, objectForKey: &*key];

    if !value.is_null() {
        let value_nsstring: &NSString = &*(value as *const NSString);
        let project_path = value_nsstring.to_string();

        // Emit event to frontend
        if let Some(app_handle) = APP_HANDLE.lock().unwrap().as_ref() {
            if let Some(window) = app_handle.get_webview_window("main") {
                let _ = window.emit(
                    "notification-clicked",
                    NotificationClickedPayload { project_path },
                );
            }
        }
    }

    // Call completion handler (it's a block)
    let completion_handler: *mut block2::Block<dyn Fn()> =
        completion_handler as *mut block2::Block<dyn Fn()>;
    if !completion_handler.is_null() {
        (*completion_handler).call(());
    }
}

/// Called when a notification is about to be presented while the app is in the foreground.
/// We return UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionSound
/// so that the notification shows up even when our app has focus.
unsafe extern "C" fn will_present_notification(
    _this: *mut AnyObject,
    _sel: Sel,
    _center: *mut AnyObject,
    _notification: *mut AnyObject,
    completion_handler: *mut AnyObject,
) {
    // UNNotificationPresentationOptionBanner = 1 << 4 = 16
    // UNNotificationPresentationOptionSound = 1 << 1 = 2
    let options: usize = 16 | 2;
    let completion_handler: *mut block2::Block<dyn Fn(usize)> =
        completion_handler as *mut block2::Block<dyn Fn(usize)>;
    if !completion_handler.is_null() {
        (*completion_handler).call((options,));
    }
}

/// Tauri command: send a native notification via UNUserNotificationCenter
#[tauri::command(rename_all = "snake_case")]
pub fn send_notification(title: String, body: String, project_path: String) {
    unsafe {
        // Create UNMutableNotificationContent
        let content: Retained<AnyObject> = msg_send![class!(UNMutableNotificationContent), new];

        // Set title
        let ns_title = NSString::from_str(&title);
        let _: () = msg_send![&*content, setTitle: &*ns_title];

        // Set body
        let ns_body = NSString::from_str(&body);
        let _: () = msg_send![&*content, setBody: &*ns_body];

        // Set sound to default
        let default_sound: Retained<AnyObject> =
            msg_send![class!(UNNotificationSound), defaultSound];
        let _: () = msg_send![&*content, setSound: &*default_sound];

        // Set userInfo with projectPath
        let key = NSString::from_str("projectPath");
        let value = NSString::from_str(&project_path);
        let user_info: Retained<AnyObject> = msg_send![
            class!(NSDictionary),
            dictionaryWithObject: &*value,
            forKey: &*key
        ];
        let _: () = msg_send![&*content, setUserInfo: &*user_info];

        // Create a unique identifier for the request
        let identifier = NSString::from_str(&format!("etm-{}", std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()));

        // Create UNNotificationRequest
        let request: Retained<AnyObject> = msg_send![
            class!(UNNotificationRequest),
            requestWithIdentifier: &*identifier,
            content: &*content,
            trigger: std::ptr::null::<AnyObject>()
        ];

        // Add request to notification center
        let center: *mut AnyObject =
            msg_send![class!(UNUserNotificationCenter), currentNotificationCenter];
        let _: () = msg_send![center, addNotificationRequest: &*request, withCompletionHandler: std::ptr::null::<AnyObject>()];
    }
}
