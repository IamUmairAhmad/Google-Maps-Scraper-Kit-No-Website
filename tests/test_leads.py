import unittest

from app.leads import (
    business_website,
    classify_status,
    csv_cell,
    has_website,
    keep_lead,
    review_count_from_panel,
    rows_to_csv,
)


class LeadFilterTests(unittest.TestCase):
    def test_open_later_today_is_still_active(self):
        self.assertEqual(classify_status("Closed · Opens 9 AM"), "active")

    def test_closed_down_labels(self):
        self.assertEqual(classify_status("Permanently closed"), "permanently closed")
        self.assertEqual(classify_status("Temporarily closed"), "temporarily closed")

    def test_blank_website_values(self):
        self.assertFalse(has_website(""))
        self.assertFalse(has_website("  "))
        self.assertFalse(has_website("n/a"))
        self.assertTrue(has_website("https://example.com"))

    def test_profile_links_are_not_a_business_website(self):
        self.assertFalse(has_website("https://www.facebook.com/asliceofeden/menu/"))
        self.assertFalse(has_website("https://instagram.com/example"))
        self.assertEqual(business_website("https://www.facebook.com/asliceofeden/menu/"), "")
        self.assertEqual(
            business_website("https://www.google.com/url?q=https%3A%2F%2Fexample.com%2F"),
            "https://example.com/",
        )

    def test_review_count_comes_from_the_place_header(self):
        panel = "Mount Dessert Bakery\n4.6\n(1,234)\nCafe\n(207) 801-9191"
        self.assertEqual(review_count_from_panel(panel), "1234")
        phone_first = "Place\n(207) 801-9191\n4.6\n(530)\n"
        self.assertEqual(review_count_from_panel(phone_first), "530")

    def test_keeps_only_active_listings_without_a_website(self):
        self.assertTrue(keep_lead({"status": "active", "website": ""}))
        self.assertFalse(keep_lead({"status": "active", "website": "https://example.com"}))
        self.assertFalse(keep_lead({"status": "permanently closed", "website": ""}))
        self.assertFalse(keep_lead({"status": "temporarily closed", "website": ""}))

    def test_csv_quotes_formula_cells_and_writes_the_lead_header(self):
        self.assertEqual(csv_cell("=cmd"), "'=cmd")
        text = rows_to_csv([
            {
                "name": "Ada Plumbing",
                "phone": "555-0100",
                "email": "",
                "website": "",
                "category": "Plumber",
                "address": "1 Main St",
                "rating": "4.8",
                "review_count": "12",
                "status": "active",
                "maps_url": "https://maps.example/place",
                "niche": "plumbers",
                "location": "Austin, TX",
            }
        ])
        self.assertTrue(text.startswith(
            "name,phone,email,website,category,address,rating,review_count,status,maps_url,niche,location\n"
        ))
        self.assertIn("Ada Plumbing", text)
        self.assertIn("Austin, TX", text)


if __name__ == "__main__":
    unittest.main()
