from django.urls import path, re_path, include
from shop import urls as shop_urls

urlpatterns = [
    path("health/", health_view),
    path("api/", include("shop.urls")),
    path("legacy/", include(shop_urls)),
    re_path(r"^old/(?P<slug>[-\w]+)/$", old_view),
]
